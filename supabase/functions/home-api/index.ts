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
//     working LINE registration link and is visible to this member
//     — same "no rows = public" group-visibility rule as job
//     templates and flows, via event_groups.
//   - one entry per 壇 (altar) the caller belongs to on ANY of its
//     three teams (天廚 via altar_team_members, 佛堂/庶務 via
//     task_group_members) that already has its own LINE link — same
//     "each has its own unique liff_id" pattern as events, since
//     every altar's hub (altar-hub.html) is its own distinct LIFF
//     app, not a shared "purpose".
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

// A task template / event / flow with altar_id set is ALSO visible to
// anyone on a team at that altar or a descendant of it — an
// additional OR-branch alongside the group rule above, so a top
// altar's content automatically shows up for every altar under it.
// Returns the set of distinct altar_ids (out of `altarIds`) that
// `existingUser` can actually see, one RPC call per distinct id.
async function visibleAltarIdSet(altarIds: string[], existingUser: { id: string } | null) {
  const result = new Set<string>();
  if (!existingUser) return result;
  for (const aid of new Set(altarIds)) {
    const { data, error } = await supabase.rpc("is_altar_visible_to_user", {
      p_altar_id: aid,
      p_user_id: existingUser.id,
    });
    if (!error && data) result.add(aid);
  }
  return result;
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
    const { data: templates } = await supabase.from("task_templates").select("id, altar_id").eq("is_active", true);
    const templateIds = (templates || []).map((t: any) => t.id);
    const templateAltarIds = (templates || []).map((t: any) => t.altar_id).filter(Boolean);
    let showTasks = templateAltarIds.length > 0 && (await visibleAltarIdSet(templateAltarIds, existingUser)).size > 0;
    if (!showTasks && templateIds.length > 0) {
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
    const { data: flows } = await supabase.from("activity_flows").select("id, altar_id").eq("is_active", true);
    const flowIds = (flows || []).map((f: any) => f.id);
    const flowAltarIds = (flows || []).map((f: any) => f.altar_id).filter(Boolean);
    let showFlows = flowAltarIds.length > 0 && (await visibleAltarIdSet(flowAltarIds, existingUser)).size > 0;
    if (!showFlows && flowIds.length > 0) {
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

    // ---- Active events with a working registration link, visible
    // to this member (same "no rows = public" group rule as job
    // templates and flows, via event_groups). ----
    const { data: eventRows } = await supabase
      .from("events")
      .select("id, name, event_date, location, liff_id, altar_id")
      .eq("is_active", true)
      .order("event_date", { ascending: true });
    const linkedEvents = (eventRows || []).filter((e: any) => e.liff_id && /^\d+-[A-Za-z0-9]+$/.test(e.liff_id));
    const linkedEventIds = linkedEvents.map((e: any) => e.id);

    let eventGroupsByEvent: Record<string, string[]> = {};
    if (linkedEventIds.length > 0) {
      const { data: eventGroupLinks } = await supabase
        .from("event_groups")
        .select("event_id, group_id")
        .in("event_id", linkedEventIds);
      (eventGroupLinks || []).forEach((r: any) => {
        (eventGroupsByEvent[r.event_id] ||= []).push(r.group_id);
      });
    }

    const eventAltarIds = linkedEvents.map((e: any) => e.altar_id).filter(Boolean);
    const visibleEventAltarIds = eventAltarIds.length > 0 ? await visibleAltarIdSet(eventAltarIds, existingUser) : new Set<string>();

    const events = linkedEvents
      .filter((e: any) => {
        if (e.altar_id && visibleEventAltarIds.has(e.altar_id)) return true; // visible via altar hierarchy
        const groups = eventGroupsByEvent[e.id];
        if (!groups || groups.length === 0) return true; // public event
        return groups.some((gid) => myGroupIds.has(gid));
      })
      .map((e: any) => ({ id: e.id, name: e.name, event_date: e.event_date, location: e.location, liff_id: e.liff_id }));

    // ---- Every altar the caller belongs to on any of its 3 teams,
    // that already has its own LINE link ----
    const [{ data: kitchenMemberships }, { data: shrineGeneralGroups }] = await Promise.all([
      supabase.from("altar_team_members").select("altar_id").eq("team", "kitchen").eq("user_id", existingUser.id),
      myGroupIds.size > 0
        ? supabase.from("task_groups").select("id, altar_id").in("id", [...myGroupIds]).not("altar_id", "is", null)
        : Promise.resolve({ data: [] }),
    ]);
    const myAltarIds = new Set<string>([
      ...(kitchenMemberships || []).map((r: any) => r.altar_id),
      ...(shrineGeneralGroups || []).map((r: any) => r.altar_id),
    ]);

    let altars: any[] = [];
    if (myAltarIds.size > 0) {
      const { data: altarRows } = await supabase
        .from("altars")
        .select("id, name, liff_id")
        .in("id", [...myAltarIds]);
      altars = (altarRows || [])
        .filter((a: any) => a.liff_id)
        .map((a: any) => ({ id: a.id, name: a.name, liff_id: a.liff_id }));
    }

    return json({
      user: existingUser,
      is_job_admin: isJobAdmin,
      is_flow_admin: isFlowAdmin,
      is_event_admin: isEventAdmin,
      show_tasks: showTasks,
      show_flows: showFlows,
      events,
      altars,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
