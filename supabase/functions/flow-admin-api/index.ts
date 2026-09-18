// =========================================================
// SUPABASE EDGE FUNCTION: flow-admin-api
//
// Backs activity-flow-admin.html — a LIFF page that's a mobile
// equivalent of the dashboard's "流程表 Flow Sheets" panel: create,
// edit, activate/deactivate, and delete activity flow sheets (with
// their day-by-day schedule items and group visibility). Same auth
// pattern as tasks-admin-api: the browser sends LINE's ID token,
// verified directly with LINE's servers, gated further so only LINE
// accounts listed in activity_flow_admins may use any action beyond
// "whoami".
//
// Actions:
//   whoami            — registers/looks up the caller's `users` row
//                        and reports whether they're a flow admin.
//                        The only action that does NOT require admin
//                        rights, so a non-admin gets a clean "not
//                        authorized" screen instead of a raw 403,
//                        and still ends up findable-by-name/phone in
//                        the dashboard so you can grant them access.
//   list_flows        — every flow with its schedule items and
//                        group_ids, for the list/edit screens.
//   list_groups       — every group, for the checkbox list.
//   save_flow         — create or update a flow (+ sync schedule
//                        items + sync group links).
//   toggle_flow_active — flip a flow's is_active flag.
//   delete_flow       — delete a flow (cascades to its items and
//                        group links).
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/flow-admin-api/**.
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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    // tasks-admin-api does — so a not-yet-authorized admin still
    // shows up in the dashboard's search once they've opened this page.
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
      .from("activity_flow_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isAdmin = !!adminRow;

    if (action === "whoami") {
      return json({ user: existingUser, is_admin: isAdmin });
    }

    if (!isAdmin) {
      return json({ error: "您沒有管理流程表的權限，請聯繫管理員。You don't have permission to manage flow sheets." }, 403);
    }

    switch (action) {
      // ---- List every flow, with its schedule items + groups ----
      case "list_flows": {
        const { data: flows, error } = await supabase
          .from("activity_flows")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 400);

        const flowIds = (flows || []).map((f: any) => f.id);
        let items: any[] = [];
        let flowGroups: any[] = [];

        if (flowIds.length > 0) {
          const { data: itemRows, error: itemsErr } = await supabase
            .from("activity_flow_items")
            .select("id, flow_id, item_date, start_time, end_time, title, sort_order")
            .in("flow_id", flowIds)
            .order("item_date", { ascending: true })
            .order("sort_order", { ascending: true });
          if (itemsErr) return json({ error: itemsErr.message }, 400);
          items = itemRows || [];

          const { data: fg, error: fgErr } = await supabase
            .from("activity_flow_groups")
            .select("flow_id, group_id")
            .in("flow_id", flowIds);
          if (fgErr) return json({ error: fgErr.message }, 400);
          flowGroups = fg || [];
        }

        const result = (flows || []).map((f: any) => ({
          ...f,
          items: items.filter((i: any) => i.flow_id === f.id),
          group_ids: flowGroups.filter((g: any) => g.flow_id === f.id).map((g: any) => g.group_id),
        }));
        return json({ flows: result });
      }

      // ---- All groups, for the checkbox list ----
      case "list_groups": {
        const { data, error } = await supabase
          .from("task_groups")
          .select("id, name")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ groups: data || [] });
      }

      // ---- Create or update a flow sheet ----
      case "save_flow": {
        const { id, name, host, facilitator, location, address, start_date, end_date, items, group_ids } = body;

        const cleanName = (name || "").trim();
        if (!cleanName) return json({ error: "請填寫班程名稱。" }, 400);
        if (!start_date || !end_date) return json({ error: "請選擇開始與結束日期。" }, 400);
        if (start_date > end_date) return json({ error: "開始日期不能晚於結束日期。" }, 400);

        const rows = (Array.isArray(items) ? items : [])
          .map((it: any, idx: number) => ({
            id: it && it.id ? it.id : null,
            item_date: it ? it.item_date : null,
            start_time: it ? it.start_time : null,
            end_time: it && it.end_time ? it.end_time : null,
            title: ((it && it.title) || "").trim(),
            sort_order: idx,
          }))
          .filter((r: any) => r.title);

        for (const r of rows) {
          if (!r.item_date || r.item_date < start_date || r.item_date > end_date) {
            return json({ error: `項目「${r.title}」的日期不在開班期間內。` }, 400);
          }
          if (!r.start_time || !HHMM.test(r.start_time)) {
            return json({ error: `項目「${r.title}」的開始時間格式不正確。` }, 400);
          }
          if (r.end_time && !HHMM.test(r.end_time)) {
            return json({ error: `項目「${r.title}」的結束時間格式不正確。` }, 400);
          }
        }

        const payload: Record<string, unknown> = {
          name: cleanName,
          host: host ? String(host).trim() : null,
          facilitator: facilitator ? String(facilitator).trim() : null,
          location: location ? String(location).trim() : null,
          address: address ? String(address).trim() : null,
          start_date,
          end_date,
          updated_at: new Date().toISOString(),
        };

        let flowId = id || null;
        if (flowId) {
          const { error } = await supabase.from("activity_flows").update(payload).eq("id", flowId);
          if (error) return json({ error: error.message }, 400);
        } else {
          payload.is_active = true;
          const { data, error } = await supabase.from("activity_flows").insert(payload).select().single();
          if (error) return json({ error: error.message }, 400);
          flowId = data.id;
        }

        // Sync schedule items: same diff pattern used everywhere else
        // in this project — update rows that already had a DB id,
        // insert new ones, delete ones removed from the list.
        const { data: existingItems } = await supabase
          .from("activity_flow_items")
          .select("id")
          .eq("flow_id", flowId);
        const existingIds = (existingItems || []).map((r: any) => r.id);
        const keptIds = rows.filter((r: any) => r.id).map((r: any) => r.id);
        const toDelete = existingIds.filter((eid: string) => !keptIds.includes(eid));

        if (toDelete.length > 0) {
          await supabase.from("activity_flow_items").delete().in("id", toDelete);
        }
        for (const row of rows) {
          const itemPayload = {
            item_date: row.item_date,
            start_time: row.start_time,
            end_time: row.end_time,
            title: row.title,
            sort_order: row.sort_order,
          };
          if (row.id) {
            await supabase.from("activity_flow_items").update(itemPayload).eq("id", row.id);
          } else {
            await supabase.from("activity_flow_items").insert({ flow_id: flowId, ...itemPayload });
          }
        }

        // Sync group links: plain join table, just diff and apply.
        const wantGroupIds = Array.isArray(group_ids) ? group_ids : [];
        const { data: existingLinks } = await supabase
          .from("activity_flow_groups")
          .select("group_id")
          .eq("flow_id", flowId);
        const existingGroupIds = (existingLinks || []).map((r: any) => r.group_id);
        const toRemoveGroups = existingGroupIds.filter((gid: string) => !wantGroupIds.includes(gid));
        const toAddGroups = wantGroupIds.filter((gid: string) => !existingGroupIds.includes(gid));

        if (toRemoveGroups.length > 0) {
          await supabase.from("activity_flow_groups").delete().eq("flow_id", flowId).in("group_id", toRemoveGroups);
        }
        if (toAddGroups.length > 0) {
          await supabase.from("activity_flow_groups").insert(toAddGroups.map((group_id: string) => ({ flow_id: flowId, group_id })));
        }

        return json({ ok: true, flow_id: flowId });
      }

      // ---- Activate/deactivate a flow sheet ----
      case "toggle_flow_active": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { data: flow } = await supabase.from("activity_flows").select("is_active").eq("id", id).maybeSingle();
        if (!flow) return json({ error: "This flow sheet no longer exists." }, 404);
        const { error } = await supabase.from("activity_flows").update({ is_active: !flow.is_active }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Delete a flow sheet ----
      case "delete_flow": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("activity_flows").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Server error. Please try again." }, 500);
  }
});
