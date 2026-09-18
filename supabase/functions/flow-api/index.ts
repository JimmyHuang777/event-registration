// =========================================================
// SUPABASE EDGE FUNCTION: flow-api
//
// Backs activity-flow.html — the member-facing LIFF page for
// viewing an "activity flow sheet" (活動流程表 / 開班行事曆): a
// class/event's header info plus its day-by-day schedule. Read-only.
// Same auth pattern as tasks-api: the browser sends LINE's ID token,
// verified directly with LINE's servers before trusting anything.
//
// Actions:
//   list_flows — active flows visible to the caller (group-gated,
//                same "no rows in activity_flow_groups = public"
//                rule as job templates), header fields only.
//   get_flow   — one flow's full header + its schedule items,
//                sorted by date then start time. 403s if the caller
//                isn't allowed to see it.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/flow-api/**. Deployed
// with --no-verify-jwt (this function does its own auth via the
// LINE ID token, so Supabase's gateway-level JWT check must stay
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

// A flow with no rows in activity_flow_groups is public. A flow WITH
// rows there is only visible to someone who belongs to at least one
// of those groups. Same rule/shape as tasks-api's isTemplateVisible.
async function isFlowVisible(flowId: string, existingUser: { id: string } | null) {
  const { data: groupLinks } = await supabase
    .from("activity_flow_groups")
    .select("group_id")
    .eq("flow_id", flowId);

  if (!groupLinks || groupLinks.length === 0) return true; // public flow

  if (!existingUser) return false;

  const { data: myGroups } = await supabase
    .from("task_group_members")
    .select("group_id")
    .eq("user_id", existingUser.id);

  const myGroupIds = new Set((myGroups || []).map((r: any) => r.group_id));
  return groupLinks.some((r: any) => myGroupIds.has(r.group_id));
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

    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    switch (action) {
      // ---- List active flows visible to the caller ----
      case "list_flows": {
        const { data: flows, error } = await supabase
          .from("activity_flows")
          .select("*")
          .eq("is_active", true)
          .order("start_date", { ascending: false });
        if (error) return json({ error: error.message }, 400);

        const allFlowIds = (flows || []).map((f: any) => f.id);
        let visibleFlowIds = new Set(allFlowIds);

        if (allFlowIds.length > 0) {
          const { data: flowGroups, error: fgErr } = await supabase
            .from("activity_flow_groups")
            .select("flow_id, group_id")
            .in("flow_id", allFlowIds);
          if (fgErr) return json({ error: fgErr.message }, 400);

          const restrictedFlowIds = new Set((flowGroups || []).map((r: any) => r.flow_id));
          if (restrictedFlowIds.size > 0) {
            let myGroupIds = new Set<string>();
            if (existingUser) {
              const { data: myGroups, error: mgErr } = await supabase
                .from("task_group_members")
                .select("group_id")
                .eq("user_id", existingUser.id);
              if (mgErr) return json({ error: mgErr.message }, 400);
              myGroupIds = new Set((myGroups || []).map((r: any) => r.group_id));
            }
            visibleFlowIds = new Set(
              allFlowIds.filter((fid: string) => {
                if (!restrictedFlowIds.has(fid)) return true; // public flow
                const groupsForFlow = (flowGroups || []).filter((r: any) => r.flow_id === fid);
                return groupsForFlow.some((r: any) => myGroupIds.has(r.group_id));
              })
            );
          }
        }

        const result = (flows || []).filter((f: any) => visibleFlowIds.has(f.id));
        return json({ user: existingUser || null, flows: result });
      }

      // ---- One flow's full header + schedule items ----
      case "get_flow": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);

        const { data: flow, error: flowErr } = await supabase
          .from("activity_flows")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (flowErr) return json({ error: flowErr.message }, 400);
        if (!flow) return json({ error: "This flow sheet no longer exists." }, 404);

        if (!(await isFlowVisible(id, existingUser))) {
          return json({ error: "這個流程表不開放給您的群組。This isn't open to your group." }, 403);
        }

        const { data: items, error: itemsErr } = await supabase
          .from("activity_flow_items")
          .select("id, item_date, start_time, end_time, title, sort_order")
          .eq("flow_id", id)
          .order("item_date", { ascending: true })
          .order("start_time", { ascending: true })
          .order("sort_order", { ascending: true });
        if (itemsErr) return json({ error: itemsErr.message }, 400);

        return json({ flow, items: items || [] });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Server error. Please try again." }, 500);
  }
});
