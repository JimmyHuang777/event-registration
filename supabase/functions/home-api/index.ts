// =========================================================
// SUPABASE EDGE FUNCTION: home-api
//
// Backs home.html — a single "entry point" LIFF page that shows a
// LINE member only the links relevant to them, instead of everyone
// needing their own list of individual LIFF links:
//   - 行功了愿表 Task Roster (tasks.html)     — shown only if at
//     least one active job template is actually visible to this
//     member (public, or restricted to a group they're in).
//   - 開班資訊表 Activity Flow (activity-flow.html) — same rule,
//     using activity_flows/activity_flow_groups.
//   - 行功了愿管理 Job Admin (tasks-admin.html) — shown only if the
//     caller is listed in task_job_admins.
//   - 流程表管理 Flow Admin (activity-flow-admin.html) — shown only
//     if the caller is listed in activity_flow_admins.
//   - 活動管理 Event Admin (event-admin.html) — shown only if the
//     caller is listed in event_admins.
//   - one entry per currently active event that already has a
//     working LINE registration link — events have no group
//     visibility rule of their own (unlike job templates/flows), so
//     every active, linked event is listed for everyone.
//
// This function only decides WHICH entries to show (booleans) — the
// actual liff_id for each fixed-purpose page is looked up by
// home.html itself via the public liff_apps read, same as every
// other page. Events are the one exception: each has its own unique
// liff_id (not a shared "purpose"), so this function returns those
// directly.
//
// Action:
//   get_menu — registers/looks up the caller's `users` row (same as
//              tasks-admin-api's whoami) and returns the flags/list
//              above.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/home-api/**.
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

// Any active row (in `activeIds`) with NO rows in `groupLinks` is
// public. Any row WITH group rows is only visible to someone in at
// least one of those groups. Same "no rows = public" rule used by
// tasks-api's isTemplateVisible and flow-api's isFlowVisible, just
// aggregated here into a single "is there at least one I can see?"
// check instead of a per-item check.
function anyVisible(
  activeIds: string[],
  groupLinks: { id: string; group_id: string }[],
  myGroupIds: Set<string>
) {
  const restrictedIds = new Set(groupLinks.map((r) => r.id));
  if (activeIds.some((id) => !restrictedIds.has(id))) return true; // a public one exists
  return groupLinks.some((r) => myGroupIds.has(r.group_id));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { idToken } = body;

    if (!idToken) return json({ error: "Missing LINE ID token." }, 401);

    const claims = await verifyLineToken(idToken);
    if (!claims) {
      return json({ error: "Your LINE session is invalid or expired. Please reopen this page from LINE." }, 401);
    }
    const lineUserId = claims.sub;

    // Always register/refresh the caller's `users` row — same as
    // tasks-admin-api / flow-admin-api's whoami — so group
    // membership and admin-list lookups work even for a first-time
    // visitor, and so they show up in the dashboard's search.
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

    const [{ data: jobAdminRow }, { data: flowAdminRow }, { data: eventAdminRow }, { data: myGroupRows }] = await Promise.all([
      supabase.from("task_job_admins").select("user_id").eq("user_id", existingUser.id).maybeSingle(),
      supabase.from("activity_flow_admins").select("user_id").eq("user_id", existingUser.id).maybeSingle(),
      supabase.from("event_admins").select("user_id").eq("user_id", existingUser.id).maybeSingle(),
      supabase.from("task_group_members").select("group_id").eq("user_id", existingUser.id),
    ]);
    const isJobAdmin = !!jobAdminRow;
    const isFlowAdmin = !!flowAdminRow;
    const isEventAdmin = !!eventAdminRow;
    const myGroupIds = new Set((myGroupRows || []).map((r: any) => r.group_id));

    // ---- Any task template visible to this member? ----
    const { data: templates } = await supabase.from("task_templates").select("id").eq("is_active", true);
    const templateIds = (templates || []).map((t: any) => t.id);
    let showTasks = false;
    if (templateIds.length > 0) {
      const { data: templateGroups } = await supabase
        .from("task_template_groups")
        .select("template_id, group_id")
        .in("template_id", templateIds);
      showTasks = anyVisible(
        templateIds,
        (templateGroups || []).map((r: any) => ({ id: r.template_id, group_id: r.group_id })),
        myGroupIds
      );
    }

    // ---- Any activity flow visible to this member? ----
    const { data: flows } = await supabase.from("activity_flows").select("id").eq("is_active", true);
    const flowIds = (flows || []).map((f: any) => f.id);
    let showFlows = false;
    if (flowIds.length > 0) {
      const { data: flowGroups } = await supabase
        .from("activity_flow_groups")
        .select("flow_id, group_id")
        .in("flow_id", flowIds);
      showFlows = anyVisible(
        flowIds,
        (flowGroups || []).map((r: any) => ({ id: r.flow_id, group_id: r.group_id })),
        myGroupIds
      );
    }

    // ---- Active events with a working registration link ----
    // Events have no group-visibility rule of their own, so every
    // active event that already has a valid liff_id is listed —
    // no per-user filtering beyond is_active.
    const { data: eventRows } = await supabase
      .from("events")
      .select("id, name, event_date, location, liff_id")
      .eq("is_active", true)
      .order("event_date", { ascending: true });
    const events = (eventRows || [])
      .filter((e: any) => e.liff_id && /^\d+-[A-Za-z0-9]+$/.test(e.liff_id))
      .map((e: any) => ({ id: e.id, name: e.name, event_date: e.event_date, location: e.location, liff_id: e.liff_id }));

    return json({
      user: existingUser,
      is_job_admin: isJobAdmin,
      is_flow_admin: isFlowAdmin,
      is_event_admin: isEventAdmin,
      show_tasks: showTasks,
      show_flows: showFlows,
      events,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
