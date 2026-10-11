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
// Altar team leaders (組長): a leader of a team listed in
// altar_manager_teams (SQL 53; default 佛堂/庶務/住壇) automatically
// manages the events whose 所屬壇 is that altar — edit the event, but
// never create, activate/deactivate or delete (those stay with
// event_admins). `whoami` reports is_global_admin / managed_altar_ids.
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
import { notifyEventOpened } from "../_shared/line.ts";

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

// Teams whose leaders manage their altar's events when altar_manager_teams
// (SQL 53) isn't there yet.
const DEFAULT_MANAGER_TEAMS = ["shrine", "general", "resident"];

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
    const isGlobalAdmin = !!adminRow;

    // Altars this person leads (in a team that grants event management).
    let managedAltarIds: string[] = [];
    {
      let teams = DEFAULT_MANAGER_TEAMS;
      const { data: tRows, error: tErr } = await supabase.from("altar_manager_teams").select("team");
      if (!tErr && tRows) teams = tRows.map((r: any) => r.team);
      if (teams.length > 0) {
        const { data: led } = await supabase
          .from("altar_team_members").select("altar_id")
          .eq("user_id", existingUser.id).eq("role", "leader").in("team", teams);
        managedAltarIds = [...new Set((led || []).map((r: any) => r.altar_id))] as string[];
      }
    }
    const isAdmin = isGlobalAdmin || managedAltarIds.length > 0;

    // Can this caller manage this event's registrations / content?
    async function canManageEvent(eventId: string): Promise<boolean> {
      if (isGlobalAdmin) return true;
      const { data: e } = await supabase.from("events").select("altar_id").eq("id", eventId).maybeSingle();
      return !!(e && e.altar_id && managedAltarIds.includes(e.altar_id));
    }

    if (action === "whoami") {
      return json({ user: existingUser, is_admin: isAdmin, is_global_admin: isGlobalAdmin, managed_altar_ids: managedAltarIds });
    }

    if (!isAdmin) {
      return json({ error: "您沒有管理活動的權限，請聯繫管理員。You don't have permission to manage events." }, 403);
    }

    switch (action) {
      // ---- List every event, with its group_ids ----
      case "list_events": {
        let evQuery = supabase
          .from("events")
          .select("id, name, slug, event_date, location, description, form_schema, is_active, liff_id, is_featured, altar_id, offers_transport, offers_lodging, registration_deadline, notify_on_open, notify_before_deadline")
          .order("event_date", { ascending: false });
        if (!isGlobalAdmin) evQuery = evQuery.in("altar_id", managedAltarIds);
        const { data: events, error } = await evQuery;
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

      // ---- Active train timetable (瑞穗站) for the 火車車次 field ----
      case "list_trains": {
        // direction: 'south'（去程，顯示抵達瑞穗時間）／'north'（回程，顯示瑞穗出發時間）；尚未執行 SQL 57 時退回舊欄位（全部視為去程）
        let { data, error } = await supabase
          .from("train_schedule").select("train_no, train_type, arrive_time, depart_time, direction")
          .eq("is_active", true);
        if (error) {
          const r = await supabase.from("train_schedule").select("train_no, train_type, arrive_time, depart_time").eq("is_active", true);
          data = r.data; error = r.error;
        }
        if (error) return json({ error: error.message }, 400);
        return json({ trains: data || [] });
      }

      // ---- All altars (id, name, parent) for the 所屬壇 picker ----
      case "list_altars": {
        const { data, error } = await supabase.from("altars").select("id, name, parent_id").order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ altars: data || [] });
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
        if (!isGlobalAdmin) {
          // Altar leaders may only edit events of their own altar.
          if (!editingId) return json({ error: "您只能編輯所屬壇的活動，無法新增活動。" }, 403);
          const { data: own } = await supabase.from("events").select("altar_id").eq("id", editingId).maybeSingle();
          if (!own || !own.altar_id || !managedAltarIds.includes(own.altar_id)) {
            return json({ error: "您沒有管理此活動的權限。" }, 403);
          }
          // Leaders can't move the event to another altar or feature it.
          delete body.altar_id;
          delete body.is_featured;
        }
        const name = (body.name || "").trim();
        const description = (body.description || "").trim() || null;
        const eventDate = body.event_date || null;
        const location = (body.location || "").trim() || null;
        const formSchema = Array.isArray(body.form_schema) ? body.form_schema : [];
        const isFeatured = !!body.is_featured;
        const featuredPatch = "is_featured" in body ? { is_featured: isFeatured } : {};
        // Optional extras: only touched when the caller sends them.
        const extras: Record<string, unknown> = {};
        if ("altar_id" in body) extras.altar_id = body.altar_id || null;
        if ("offers_transport" in body) extras.offers_transport = !!body.offers_transport;
        if ("offers_lodging" in body) extras.offers_lodging = !!body.offers_lodging;
        if ("notify_on_open" in body) extras.notify_on_open = !!body.notify_on_open;
        if ("notify_before_deadline" in body) extras.notify_before_deadline = !!body.notify_before_deadline;
        if ("registration_deadline" in body) {
          const dl = body.registration_deadline;
          if (dl && Number.isNaN(Date.parse(dl))) return json({ error: "報名截止時間格式不正確。" }, 400);
          extras.registration_deadline = dl ? new Date(dl).toISOString() : null;
        }
        const groupIds: string[] = Array.isArray(body.group_ids) ? body.group_ids : [];

        if (!name) return json({ error: "請填寫活動名稱。" }, 400);

        if (editingId) {
          const { error: updateErr } = await supabase
            .from("events")
            .update({ name, description, event_date: eventDate, location, form_schema: formSchema, ...featuredPatch, ...extras })
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
          .insert({ name, description, event_date: eventDate, location, slug, form_schema: formSchema, is_featured: isFeatured, ...extras })
          .select()
          .single();
        if (insertErr) return json({ error: insertErr.message }, 400);

        await syncEventGroups(newEvent.id, groupIds);

        // 開始報名通知（預設開啟；失敗不影響建立，結果記錄在 line_push_log）
        let notify: unknown = null;
        try { notify = await notifyEventOpened(supabase, newEvent.id); } catch (e) { console.error(e); }

        return json({ ok: true, event: newEvent, notify });
      }

      // ---- Registrations of one event (view + check-in) ----
      // Global event admins: any event. Altar leaders: their altar's events.
      case "list_registrations": {
        const eventId = body.event_id;
        if (!eventId) return json({ error: "Missing event_id." }, 400);
        if (!(await canManageEvent(eventId))) return json({ error: "您沒有管理此活動的權限。" }, 403);
        const { data: ev } = await supabase.from("events").select("id, name, form_schema").eq("id", eventId).maybeSingle();
        const { data, error } = await supabase
          .from("registrations")
          .select("id, status, notes, extra_data, attendee_name, created_at, users ( display_name )")
          .eq("event_id", eventId)
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 400);
        return json({ event: ev, registrations: data || [] });
      }

      // ---- Change registration status (確認 / 報到 / 取消) ----
      case "set_registration_status": {
        const ids: string[] = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
        const status = body.status;
        if (ids.length === 0) return json({ error: "Missing ids." }, 400);
        if (!["pending", "confirmed", "checked_in", "cancelled"].includes(status)) return json({ error: "Invalid status." }, 400);
        const { data: regs } = await supabase.from("registrations").select("id, event_id").in("id", ids);
        const eventIds = [...new Set((regs || []).map((r: any) => r.event_id))];
        if (!regs || regs.length !== ids.length) return json({ error: "找不到部分報名資料。" }, 404);
        for (const eid of eventIds) {
          if (!(await canManageEvent(eid as string))) return json({ error: "您沒有管理此活動的權限。" }, 403);
        }
        const { error } = await supabase.from("registrations").update({ status }).in("id", ids);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Toggle active/inactive ----
      case "toggle_event_active": {
        if (!isGlobalAdmin) return json({ error: "只有活動管理員可以啟用或停用活動。" }, 403);
        const { id, is_active } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("events").update({ is_active: !!is_active }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        let notify: unknown = null;
        if (is_active) { try { notify = await notifyEventOpened(supabase, id); } catch (e) { console.error(e); } }
        return json({ ok: true, notify });
      }

      // ---- Delete an event ----
      case "delete_event": {
        if (!isGlobalAdmin) return json({ error: "只有活動管理員可以刪除活動。" }, 403);
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
    return json({ error: "伺服器發生錯誤，請稍後再試。Server error." }, 500);
  }
});
