// =========================================================
// SUPABASE EDGE FUNCTION: altar-team-api
//
// Backs altar-hub.html's per-team pages (壇 → 各組): 成員、工作細則
// （6W 簡流表）、交接項目、整組對調. Every action is scoped to one
// (altar, team) pair via altar_team_members.
//
// Who may do what:
//   - any member/leader of the team  → read members, rules, handover
//   - the team's leader               → add/remove 組員, edit rules and
//                                      handover, propose/answer swaps
//   - global task admin (task_job_admins) → everything, incl. making
//                                      someone 組長 and swapping directly
//   Only a global admin can set role = 'leader' (組長 is assigned by hand).
//
// Actions:
//   overview        — caller's teams in an altar + pending swaps
//   members_list / members_search / member_add / member_remove
//   rules_list / rule_save / rule_delete
//   handover_list / handover_save / handover_delete /
//   handover_toggle / handover_reset
//   swap_propose / swap_respond / swap_cancel
//
// DEPLOY: GitHub Actions deploys on push to supabase/functions/altar-team-api/**
// (--no-verify-jwt: own auth via LINE ID token).
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
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
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

const TEAMS = ["kitchen", "shrine", "general", "resident"];
const TASK_TEAMS = ["shrine", "general", "resident"]; // teams that own a task_group
const str = (v: unknown, max: number) => String(v == null ? "" : v).trim().slice(0, max);
const strOrNull = (v: unknown, max: number) => str(v, max) || null;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const body = await req.json();
    const { action, idToken } = body;
    if (!idToken) return json({ error: "Missing LINE ID token." }, 401);
    const claims = await verifyLineToken(idToken);
    if (!claims) return json({ error: "Your LINE session is invalid or expired. Please reopen this page from LINE." }, 401);

    let { data: me } = await supabase.from("users").select("*").eq("line_user_id", claims.sub).maybeSingle();
    if (!me) {
      const { data: nu, error: ne } = await supabase.from("users")
        .upsert({ line_user_id: claims.sub, display_name: claims.name || "LINE User", line_picture_url: claims.picture || null, updated_at: new Date().toISOString() }, { onConflict: "line_user_id" })
        .select().single();
      if (ne) return json({ error: ne.message }, 400);
      me = nu;
    }

    const { data: adminRow } = await supabase.from("task_job_admins").select("user_id").eq("user_id", me.id).maybeSingle();
    const isGlobal = !!adminRow;

    async function roleIn(altarId: string, team: string): Promise<string | null> {
      const { data } = await supabase.from("altar_team_members").select("role")
        .eq("altar_id", altarId).eq("team", team).eq("user_id", me.id).maybeSingle();
      return data ? data.role : null;
    }
    async function canView(altarId: string, team: string) { return isGlobal || !!(await roleIn(altarId, team)); }
    async function canLead(altarId: string, team: string) { return isGlobal || (await roleIn(altarId, team)) === "leader"; }
    function checkTeam(team: unknown): string | null { return TEAMS.includes(String(team)) ? String(team) : null; }

    async function groupId(altarId: string, team: string): Promise<string | null> {
      if (!TASK_TEAMS.includes(team)) return null;
      const { data } = await supabase.from("task_groups").select("id").eq("altar_id", altarId).eq("team", team).maybeSingle();
      return data ? data.id : null;
    }
    async function syncJoin(altarId: string, team: string, userId: string) {
      const gid = await groupId(altarId, team);
      if (gid) await supabase.from("task_group_members").insert({ group_id: gid, user_id: userId }); // duplicate → ignored
    }
    async function syncLeave(altarId: string, team: string, userId: string) {
      const gid = await groupId(altarId, team);
      if (gid) await supabase.from("task_group_members").delete().eq("group_id", gid).eq("user_id", userId);
    }

    // Swap the members of two teams in one altar. Users who are on both
    // teams stay put. include_leaders=false → only role 'member' rows move.
    async function executeSwap(sw: any) {
      const { altar_id: altarId, team_a: A, team_b: B } = sw;
      const { data: rows } = await supabase.from("altar_team_members").select("user_id, role, team")
        .eq("altar_id", altarId).in("team", [A, B]);
      const inA = (rows || []).filter((r: any) => r.team === A && (sw.include_leaders || r.role === "member"));
      const inB = (rows || []).filter((r: any) => r.team === B && (sw.include_leaders || r.role === "member"));
      const setA = new Set((rows || []).filter((r: any) => r.team === A).map((r: any) => r.user_id));
      const setB = new Set((rows || []).filter((r: any) => r.team === B).map((r: any) => r.user_id));
      const moveAtoB = inA.filter((r: any) => !setB.has(r.user_id));
      const moveBtoA = inB.filter((r: any) => !setA.has(r.user_id));
      // Update by (altar, team, user) so nothing collides: no moved user is already on the target team.
      for (const r of moveAtoB) {
        const { error } = await supabase.from("altar_team_members").update({ team: B })
          .eq("altar_id", altarId).eq("team", A).eq("user_id", r.user_id);
        if (error) throw new Error(error.message);
      }
      for (const r of moveBtoA) {
        const { error } = await supabase.from("altar_team_members").update({ team: A })
          .eq("altar_id", altarId).eq("team", B).eq("user_id", r.user_id);
        if (error) throw new Error(error.message);
      }
      for (const r of moveAtoB) { await syncLeave(altarId, A, r.user_id); await syncJoin(altarId, B, r.user_id); }
      for (const r of moveBtoA) { await syncLeave(altarId, B, r.user_id); await syncJoin(altarId, A, r.user_id); }
      return { moved_a_to_b: moveAtoB.length, moved_b_to_a: moveBtoA.length };
    }

    switch (action) {
      // ---------------------------------------------------------
      case "overview": {
        const { altar_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        const { data: mine } = await supabase.from("altar_team_members").select("team, role").eq("altar_id", altar_id).eq("user_id", me.id);
        const { data: sw } = await supabase.from("altar_team_swaps").select("*").eq("altar_id", altar_id).eq("status", "pending").order("created_at", { ascending: false });
        const reqIds = [...new Set((sw || []).map((s: any) => s.requested_by).filter(Boolean))];
        const { data: us } = reqIds.length ? await supabase.from("users").select("id, display_name").in("id", reqIds) : { data: [] };
        const nm = new Map((us || []).map((u: any) => [u.id, u.display_name]));
        return json({
          is_global: isGlobal,
          teams: mine || [],
          swaps: (sw || []).map((s: any) => ({ ...s, requested_by_name: nm.get(s.requested_by) || "—" })),
        });
      }

      // ---------------------------------------------------------
      case "members_list": {
        const { altar_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team) return json({ error: "Missing altar_id/team." }, 400);
        if (!(await canView(altar_id, team))) return json({ error: "您不在這一組。" }, 403);
        const { data: ms } = await supabase.from("altar_team_members").select("user_id, role").eq("altar_id", altar_id).eq("team", team);
        const ids = (ms || []).map((m: any) => m.user_id);
        const { data: us } = ids.length ? await supabase.from("users").select("id, display_name, line_picture_url").in("id", ids) : { data: [] };
        const by = new Map((us || []).map((u: any) => [u.id, u]));
        const members = (ms || []).map((m: any) => ({ user_id: m.user_id, role: m.role, name: by.get(m.user_id)?.display_name || "—", picture: by.get(m.user_id)?.line_picture_url || null }))
          .sort((a: any, b: any) => (a.role === b.role ? 0 : a.role === "leader" ? -1 : 1));
        return json({ members, can_manage: await canLead(altar_id, team), is_global: isGlobal });
      }

      case "members_search": {
        const q = str(body.q, 40);
        if (!q) return json({ users: [] });
        if (!isGlobal) {
          const { data: led } = await supabase.from("altar_team_members").select("altar_id").eq("user_id", me.id).eq("role", "leader").limit(1);
          if (!led || led.length === 0) return json({ error: "只有組長可以搜尋人員。" }, 403);
        }
        const { data } = await supabase.from("users").select("id, display_name").ilike("display_name", `%${q.replace(/[%_]/g, "")}%`).limit(15);
        return json({ users: data || [] });
      }

      case "member_add": {
        const { altar_id, user_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team || !user_id) return json({ error: "Missing fields." }, 400);
        if (!(await canLead(altar_id, team))) return json({ error: "只有該組組長可以新增組員。" }, 403);
        const wantLeader = body.role === "leader";
        if (wantLeader && !isGlobal) return json({ error: "組長需由管理員指定。" }, 403);
        const { data: ex } = await supabase.from("altar_team_members").select("role").eq("altar_id", altar_id).eq("team", team).eq("user_id", user_id).maybeSingle();
        if (ex && ex.role === "leader" && !wantLeader && !isGlobal) return json({ error: "此人已是組長。" }, 400);
        const role = wantLeader ? "leader" : (ex && ex.role === "leader" ? "leader" : "member");
        const { error } = await supabase.from("altar_team_members").upsert({ altar_id, team, user_id, role }, { onConflict: "altar_id,team,user_id" });
        if (error) return json({ error: error.message }, 400);
        await syncJoin(altar_id, team, user_id);
        return json({ ok: true });
      }

      case "member_remove": {
        const { altar_id, user_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team || !user_id) return json({ error: "Missing fields." }, 400);
        if (!(await canLead(altar_id, team))) return json({ error: "只有該組組長可以移除組員。" }, 403);
        const { data: ex } = await supabase.from("altar_team_members").select("role").eq("altar_id", altar_id).eq("team", team).eq("user_id", user_id).maybeSingle();
        if (ex && ex.role === "leader" && !isGlobal) return json({ error: "組長需由管理員調整。" }, 403);
        const { error } = await supabase.from("altar_team_members").delete().eq("altar_id", altar_id).eq("team", team).eq("user_id", user_id);
        if (error) return json({ error: error.message }, 400);
        await syncLeave(altar_id, team, user_id);
        return json({ ok: true });
      }

      // ---------------------------------------------------------
      case "rules_list": {
        const { altar_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team) return json({ error: "Missing altar_id/team." }, 400);
        if (!(await canView(altar_id, team))) return json({ error: "您不在這一組。" }, 403);
        const { data: rules } = await supabase.from("altar_team_rules").select("*").eq("altar_id", altar_id).eq("team", team).order("sort_order").order("created_at");
        const ids = (rules || []).map((r: any) => r.id);
        const { data: rows } = ids.length ? await supabase.from("altar_team_rule_rows").select("*").in("rule_id", ids).order("sort_order") : { data: [] };
        return json({
          rules: (rules || []).map((r: any) => ({ ...r, rows: (rows || []).filter((x: any) => x.rule_id === r.id) })),
          can_manage: await canLead(altar_id, team),
        });
      }

      case "rule_save": {
        const { altar_id, rule } = body; const team = checkTeam(body.team);
        if (!altar_id || !team || !rule) return json({ error: "Missing fields." }, 400);
        if (!(await canLead(altar_id, team))) return json({ error: "只有該組組長可以編輯工作細則。" }, 403);
        const title = str(rule.title, 80);
        if (!title) return json({ error: "請填寫工作項目名稱。" }, 400);
        let ruleId = rule.id as string | undefined;
        if (ruleId) {
          const { data: own } = await supabase.from("altar_team_rules").select("id").eq("id", ruleId).eq("altar_id", altar_id).eq("team", team).maybeSingle();
          if (!own) return json({ error: "找不到這份工作細則。" }, 404);
          await supabase.from("altar_team_rules").update({ title, owners: strOrNull(rule.owners, 200), updated_at: new Date().toISOString() }).eq("id", ruleId);
          await supabase.from("altar_team_rule_rows").delete().eq("rule_id", ruleId);
        } else {
          const { data: last } = await supabase.from("altar_team_rules").select("sort_order").eq("altar_id", altar_id).eq("team", team).order("sort_order", { ascending: false }).limit(1);
          const { data: ins, error } = await supabase.from("altar_team_rules")
            .insert({ altar_id, team, title, owners: strOrNull(rule.owners, 200), sort_order: last && last[0] ? last[0].sort_order + 1 : 0 }).select("id").single();
          if (error) return json({ error: error.message }, 400);
          ruleId = ins.id;
        }
        const rows = (Array.isArray(rule.rows) ? rule.rows : []).map((r: any, i: number) => ({
          rule_id: ruleId, sort_order: i,
          when_text: strOrNull(r.when_text, 300), what_text: strOrNull(r.what_text, 3000), who_text: strOrNull(r.who_text, 300),
          where_text: strOrNull(r.where_text, 300), how_text: strOrNull(r.how_text, 3000), why_text: strOrNull(r.why_text, 3000),
        })).filter((r: any) => r.when_text || r.what_text || r.who_text || r.where_text || r.how_text || r.why_text);
        if (rows.length) {
          const { error } = await supabase.from("altar_team_rule_rows").insert(rows);
          if (error) return json({ error: error.message }, 400);
        }
        return json({ ok: true, id: ruleId });
      }

      case "rule_delete": {
        const { id } = body;
        const { data: r } = await supabase.from("altar_team_rules").select("altar_id, team").eq("id", id).maybeSingle();
        if (!r) return json({ error: "找不到這份工作細則。" }, 404);
        if (!(await canLead(r.altar_id, r.team))) return json({ error: "只有該組組長可以刪除。" }, 403);
        await supabase.from("altar_team_rules").delete().eq("id", id);
        return json({ ok: true });
      }

      // ---------------------------------------------------------
      case "handover_list": {
        const { altar_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team) return json({ error: "Missing altar_id/team." }, 400);
        if (!(await canView(altar_id, team))) return json({ error: "您不在這一組。" }, 403);
        const { data: items } = await supabase.from("altar_team_handover_items").select("*").eq("altar_id", altar_id).eq("team", team).order("sort_order").order("created_at");
        const ids = [...new Set((items || []).map((i: any) => i.confirmed_by).filter(Boolean))];
        const { data: us } = ids.length ? await supabase.from("users").select("id, display_name").in("id", ids) : { data: [] };
        const nm = new Map((us || []).map((u: any) => [u.id, u.display_name]));
        return json({ items: (items || []).map((i: any) => ({ ...i, confirmed_by_name: i.confirmed_by ? (nm.get(i.confirmed_by) || "—") : null })), can_manage: await canLead(altar_id, team) });
      }

      case "handover_save": {
        const { altar_id, item } = body; const team = checkTeam(body.team);
        if (!altar_id || !team || !item) return json({ error: "Missing fields." }, 400);
        if (!(await canLead(altar_id, team))) return json({ error: "只有該組組長可以編輯交接項目。" }, 403);
        const title = str(item.title, 120);
        if (!title) return json({ error: "請填寫交接項目。" }, 400);
        if (item.id) {
          const { error } = await supabase.from("altar_team_handover_items").update({ title, note: strOrNull(item.note, 1000) }).eq("id", item.id).eq("altar_id", altar_id).eq("team", team);
          if (error) return json({ error: error.message }, 400);
        } else {
          const { data: last } = await supabase.from("altar_team_handover_items").select("sort_order").eq("altar_id", altar_id).eq("team", team).order("sort_order", { ascending: false }).limit(1);
          const { error } = await supabase.from("altar_team_handover_items").insert({ altar_id, team, title, note: strOrNull(item.note, 1000), sort_order: last && last[0] ? last[0].sort_order + 1 : 0 });
          if (error) return json({ error: error.message }, 400);
        }
        return json({ ok: true });
      }

      case "handover_delete": {
        const { id } = body;
        const { data: r } = await supabase.from("altar_team_handover_items").select("altar_id, team").eq("id", id).maybeSingle();
        if (!r) return json({ error: "找不到這個項目。" }, 404);
        if (!(await canLead(r.altar_id, r.team))) return json({ error: "只有該組組長可以刪除。" }, 403);
        await supabase.from("altar_team_handover_items").delete().eq("id", id);
        return json({ ok: true });
      }

      case "handover_toggle": {
        const { id, confirmed } = body;
        const { data: r } = await supabase.from("altar_team_handover_items").select("altar_id, team").eq("id", id).maybeSingle();
        if (!r) return json({ error: "找不到這個項目。" }, 404);
        if (!(await canLead(r.altar_id, r.team))) return json({ error: "只有該組組長可以確認交接。" }, 403);
        await supabase.from("altar_team_handover_items").update(confirmed ? { confirmed_at: new Date().toISOString(), confirmed_by: me.id } : { confirmed_at: null, confirmed_by: null }).eq("id", id);
        return json({ ok: true });
      }

      case "handover_reset": {
        const { altar_id } = body; const team = checkTeam(body.team);
        if (!altar_id || !team) return json({ error: "Missing altar_id/team." }, 400);
        if (!(await canLead(altar_id, team))) return json({ error: "只有該組組長可以重新開始交接。" }, 403);
        await supabase.from("altar_team_handover_items").update({ confirmed_at: null, confirmed_by: null }).eq("altar_id", altar_id).eq("team", team);
        return json({ ok: true });
      }

      // ---------------------------------------------------------
      case "swap_propose": {
        const { altar_id } = body; const a = checkTeam(body.team_a); const b = checkTeam(body.team_b);
        if (!altar_id || !a || !b || a === b) return json({ error: "請選擇兩個不同的組。" }, 400);
        if (!(await canLead(altar_id, a))) return json({ error: "只有該組組長可以發起對調。" }, 403);
        const include_leaders = body.include_leaders !== false;
        const { data: dup } = await supabase.from("altar_team_swaps").select("id").eq("altar_id", altar_id).eq("status", "pending")
          .or(`and(team_a.eq.${a},team_b.eq.${b}),and(team_a.eq.${b},team_b.eq.${a})`).limit(1);
        if (dup && dup.length) return json({ error: "這兩組已有一筆待確認的對調。" }, 400);
        const { data: sw, error } = await supabase.from("altar_team_swaps")
          .insert({ altar_id, team_a: a, team_b: b, include_leaders, requested_by: me.id }).select().single();
        if (error) return json({ error: error.message }, 400);
        if (isGlobal) {
          const res = await executeSwap(sw);
          await supabase.from("altar_team_swaps").update({ status: "accepted", resolved_at: new Date().toISOString(), resolved_by: me.id }).eq("id", sw.id);
          return json({ ok: true, executed: true, ...res });
        }
        return json({ ok: true, executed: false });
      }

      case "swap_respond": {
        const { id, accept } = body;
        const { data: sw } = await supabase.from("altar_team_swaps").select("*").eq("id", id).maybeSingle();
        if (!sw || sw.status !== "pending") return json({ error: "這筆對調已處理或不存在。" }, 400);
        if (!(await canLead(sw.altar_id, sw.team_b))) return json({ error: "需由對方組長（或管理員）回覆。" }, 403);
        if (!accept) {
          await supabase.from("altar_team_swaps").update({ status: "declined", resolved_at: new Date().toISOString(), resolved_by: me.id }).eq("id", id);
          return json({ ok: true, executed: false });
        }
        const res = await executeSwap(sw);
        await supabase.from("altar_team_swaps").update({ status: "accepted", resolved_at: new Date().toISOString(), resolved_by: me.id }).eq("id", id);
        return json({ ok: true, executed: true, ...res });
      }

      case "swap_cancel": {
        const { id } = body;
        const { data: sw } = await supabase.from("altar_team_swaps").select("*").eq("id", id).maybeSingle();
        if (!sw || sw.status !== "pending") return json({ error: "這筆對調已處理或不存在。" }, 400);
        if (!(sw.requested_by === me.id || (await canLead(sw.altar_id, sw.team_a)))) return json({ error: "只有發起人可以取消。" }, 403);
        await supabase.from("altar_team_swaps").update({ status: "cancelled", resolved_at: new Date().toISOString(), resolved_by: me.id }).eq("id", id);
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
