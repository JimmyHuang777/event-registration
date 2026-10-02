// =========================================================
// SUPABASE EDGE FUNCTION: events-admin-api
//
// Backs event-admin.html — a LIFF page that's a mobile equivalent of
// the dashboard's "New Event" / "Manage Events" panels: create, edit,
// activate/deactivate, and delete events (including the custom
// registration-form field builder). Authenticated the same way as
// tasks-admin-api / flow-admin-api (the browser sends LINE's ID
// token, verified directly with LINE's servers), gated further so
// only LINE accounts listed in event_admins may use any action
// beyond "whoami".
//
// Events no longer have their own LIFF links: the whole system runs on
// one Home LIFF app and Home links to index.html?event=<slug>.
//
// Actions:
//   whoami             — registers/looks up the caller's `users` row
//                        and reports whether they're an event admin.
//   list_events        — every event with its group_ids, for the
//                        list/edit screens.
//   list_groups        — every group, for the checkbox list.
//   save_event         — create or update
//                        an event (+ sync group links).
//   toggle_event_active — flip an event's is_active flag.
//   delete_event       — delete an event.
//
// Carpool (共乘) matching has moved to its own dedicated carpool-api
// Edge Function, gated by the separate car_manager_admins list rather
// than event_admins — this function no longer handles it.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/events-admin-api/**.
// Deployed with --no-verify-jwt (this function does its own auth via
// the LINE ID token, so Supabase's gateway-level JWT check must stay
// off — see the workflow file).
// =========================================================

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function verifyLineToken(idToken: string) {
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.sub) return null;
  return data as { sub: string; name?: string; picture?: string };
}

const SLUG_RE = /^[a-z0-9-]+$/;

// Replace an event's group links with whatever was submitted — a
// plain join table, so no ids to preserve, just diff and apply. Same
// approach the dashboard uses for task_template_groups.
async function syncEventGroups(eventId: string, groupIds: string[]) {
  const { data: existingLinks } = await supabase.from("event_groups").select("group_id").eq("event_id", eventId);
  const existingIds = (existingLinks || []).map((r: any) => r.group_id);
  const toRemove = existingIds.filter((id: string) => !groupIds.includes(id));
  const toAdd = groupIds.filter((id) => !existingIds.includes(id));

  if (toRemove.length > 0) {
    await supabase.from("event_groups").delete().eq("event_id", eventId).in("group_id", toRemove);
  }
  if (toAdd.length > 0) {
    await supabase.from("event_groups").insert(toAdd.map((group_id) => ({ event_id: eventId, group_id })));
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { action, idToken } = body;

    if (!idToken) return json({ error: "Missing LINE ID token." }, 401);

    const claims = await verifyLineToken(idToken);
    if (!claims) {
      return json({ error: "Your LINE session is invalid or expired. Please reopen this page from LINE." }, 401);
    }
    const lineUserId = claims.sub;

    // Always register/refresh the caller's `users` row — same as
    // tasks-admin-api / flow-admin-api's whoami.
    let { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    if (!existingUser) {
      const { data: newUser, error: newUserErr } = await supabase
        .from("users")
        .upsert(
          {
            line_user_id: lineUserId,
            display_name: claims.name || "LINE User",
            line_picture_url: claims.picture || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "line_user_id" }
        )
        .select()
        .single();
      if (newUserErr) return json({ error: newUserErr.message }, 400);
      existingUser = newUser;
    }

    const { data: adminRow } = await supabase
      .from("event_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isAdmin = !!adminRow;

    if (action === "whoami") {
      return json({ user: existingUser, is_admin: isAdmin });
    }

    if (!isAdmin) {
      return json({ error: "您沒有管理活動的權限，請聯繫管理員。You don't have permission to manage events." }, 403);
    }

    switch (action) {
      // ---- List every event, with its group_ids ----
      case "list_events": {
        const { data: events, error } = await supabase
          .from("events")
          .select("id, name, slug, event_date, location, description, form_schema, is_active, liff_id")
          .order("event_date", { ascending: false });
        if (error) return json({ error: error.message }, 400);

        const eventIds = (events || []).map((e: any) => e.id);
        let groupsByEvent: Record<string, string[]> = {};
        if (eventIds.length > 0) {
          const { data: links } = await supabase.from("event_groups").select("event_id, group_id").in("event_id", eventIds);
          (links || []).forEach((r: any) => {
            (groupsByEvent[r.event_id] ||= []).push(r.group_id);
          });
        }
        const withGroups = (events || []).map((e: any) => ({ ...e, group_ids: groupsByEvent[e.id] || [] }));
        return json({ events: withGroups });
      }

      // ---- List every group ----
      case "list_groups": {
        const { data, error } = await supabase.from("task_groups").select("id, name").order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ groups: data || [] });
      }

      // ---- Create or update an event ----
      case "save_event": {
        const editingId = body.editing_id || null;
        const name = (body.name || "").trim();
        const description = (body.description || "").trim() || null;
        const eventDate = body.event_date || null;
        const location = (body.location || "").trim() || null;
        const formSchema = Array.isArray(body.form_schema) ? body.form_schema : [];
        const groupIds: string[] = Array.isArray(body.group_ids) ? body.group_ids : [];

        if (!name) return json({ error: "請填寫活動名稱。" }, 400);

        if (editingId) {
          const { error: updateErr } = await supabase
            .from("events")
            .update({ name, description, event_date: eventDate, location, form_schema: formSchema })
            .eq("id", editingId);
          if (updateErr) return json({ error: updateErr.message }, 400);
          await syncEventGroups(editingId, groupIds);
          return json({ ok: true });
        }

        const slug = (body.slug || "").trim();
        if (!slug) return json({ error: "請填寫連結代碼。" }, 400);
        if (!SLUG_RE.test(slug)) return json({ error: "連結代碼只能使用英文小寫、數字與連字號。" }, 400);

        const { data: newEvent, error: insertErr } = await supabase
          .from("events")
          .insert({ name, description, event_date: eventDate, location, slug, form_schema: formSchema })
          .select()
          .single();
        if (insertErr) return json({ error: insertErr.message }, 400);

        await syncEventGroups(newEvent.id, groupIds);

        return json({ ok: true, event: newEvent });
      }

      // ---- Toggle active/inactive ----
      case "toggle_event_active": {
        const { id, is_active } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("events").update({ is_active: !!is_active }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Delete an event ----
      case "delete_event": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("events").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
