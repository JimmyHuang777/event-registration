// =========================================================
// SUPABASE EDGE FUNCTION: tasks-admin-api
//
// Backs tasks-admin.html — a LIFF page that's a mobile equivalent of
// the dashboard's "任務管理 Task Management" Templates panel: create,
// edit, activate/deactivate, and delete job templates (with their
// sub-tasks and group visibility), plus save/apply/delete job
// presets. Authenticated the same way as tasks-api (the browser
// sends LINE's ID token, verified directly with LINE's servers), but
// gated further: only LINE accounts listed in task_job_admins may
// use any action beyond "whoami".
//
// Actions:
//   whoami           — registers/looks up the caller's `users` row
//                       and reports whether they're a job admin.
//                       The only action that does NOT require admin
//                       rights (so a non-admin gets a clean "not
//                       authorized" screen instead of a raw 403, and
//                       still ends up findable-by-name/phone in the
//                       dashboard so you can grant them access).
//   list_templates   — every job template with its subtasks and
//                       group_ids, for the list/edit screens.
//   list_groups      — every group, for the checkbox list.
//   list_presets     — every saved job preset.
//   save_template     — create or update a template (+ sync
//                       subtasks + sync group links).
//   toggle_template_active — flip a template's is_active flag.
//   delete_template  — delete a template (cascades to its subtasks,
//                       instances, assignments, group links).
//   save_preset      — create or overwrite a preset (by name).
//   delete_preset    — delete a preset.
//
// Scoped access (階段二): besides the global task_job_admins list, a
// LEADER (組長) of 佛堂 / 庶務 / 住壇 in an altar may manage only the
// jobs of their OWN altar + team — i.e. jobs linked exclusively to that
// altar/team's task_group (task_groups.altar_id + team). Leaders can't
// feature jobs or touch other groups' jobs; everything else here is
// unchanged for task_job_admins.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/tasks-admin-api/**.
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

// Teams whose leaders manage their altar's jobs (kitchen has its own system).
const TASK_TEAMS = ["shrine", "general", "resident"];

// 管理者權限矩陣 (Admin Permissions): one tick per feature list. Only the
// global task admins (task_job_admins) may use it — it writes the same six
// tables the Dashboard's 管理者權限 screen does.
const PERM_TABLES: Record<string, string> = {
  event: "event_admins", task: "task_job_admins", car: "car_manager_admins",
  lodging: "lodging_manager_admins", meeting: "meeting_admins", flow: "activity_flow_admins",
};
const TEAM_KEYS = ["kitchen", "shrine", "general", "resident"];

const RECURRENCES = ["daily", "weekly", "monthly", "once"];

// Same visibility rule the member page enforces (tasks-api isTemplateVisible):
// visible via the template's altar hierarchy, OR the template has no group
// limits (public), OR the user belongs to one of its groups.
async function userCanSeeTemplate(templateId: string, userId: string) {
  const { data: template } = await supabase.from("task_templates").select("altar_id").eq("id", templateId).maybeSingle();
  if (template?.altar_id) {
    const { data, error } = await supabase.rpc("is_altar_visible_to_user", { p_altar_id: template.altar_id, p_user_id: userId });
    if (!error && data) return true;
  }
  const { data: links } = await supabase.from("task_template_groups").select("group_id").eq("template_id", templateId);
  if (!links || links.length === 0) return true;
  const { data: mem } = await supabase
    .from("task_group_members").select("group_id")
    .eq("user_id", userId).in("group_id", links.map((r: any) => r.group_id));
  return !!(mem && mem.length > 0);
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
    // tasks-api does for a first-time subtask claim — so a not-yet
    // authorized admin still shows up in the dashboard's search once
    // they've opened this page.
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
      .from("task_job_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isGlobalAdmin = !!adminRow;

    // Task groups this person leads: (altar, team) pairs where they're
    // the leader of a 佛堂/庶務/住壇 team, mapped to that team's group.
    let ledGroupIds: string[] = [];
    let ledAltarIds: string[] = [];
    if (!isGlobalAdmin) {
      const { data: led } = await supabase
        .from("altar_team_members").select("altar_id, team")
        .eq("user_id", existingUser.id).eq("role", "leader").in("team", TASK_TEAMS);
      if (led && led.length > 0) {
        ledAltarIds = [...new Set(led.map((r: any) => r.altar_id))] as string[];
        const { data: grps } = await supabase
          .from("task_groups").select("id, altar_id, team").in("altar_id", ledAltarIds);
        ledGroupIds = (grps || [])
          .filter((g: any) => led.some((l: any) => l.altar_id === g.altar_id && l.team === g.team))
          .map((g: any) => g.id);
      }
    }
    const isAdmin = isGlobalAdmin || ledGroupIds.length > 0;

    if (action === "whoami") {
      return json({ user: existingUser, is_admin: isAdmin, is_global_admin: isGlobalAdmin, led_group_ids: ledGroupIds });
    }

    // Can this caller manage this job template? Leaders: only jobs linked
    // to at least one group, all of which they lead.
    async function canManageTemplate(templateId: string): Promise<boolean> {
      if (isGlobalAdmin) return true;
      const { data: links } = await supabase.from("task_template_groups").select("group_id").eq("template_id", templateId);
      return !!links && links.length > 0 && links.every((l: any) => ledGroupIds.includes(l.group_id));
    }
    // Template ids (from a list) the caller may manage.
    async function manageableTemplateIds(templateIds: string[]): Promise<Set<string>> {
      if (isGlobalAdmin) return new Set(templateIds);
      if (templateIds.length === 0) return new Set();
      const { data: links } = await supabase.from("task_template_groups").select("template_id, group_id").in("template_id", templateIds);
      const by: Record<string, string[]> = {};
      (links || []).forEach((l: any) => { (by[l.template_id] ||= []).push(l.group_id); });
      return new Set(templateIds.filter((id) => (by[id] || []).length > 0 && by[id].every((g) => ledGroupIds.includes(g))));
    }

    if (!isAdmin) {
      return json({ error: "您沒有管理工作的權限，請聯繫管理員。You don't have permission to manage jobs." }, 403);
    }

    switch (action) {
      // ---- 管理者權限 (global task admins only) ----
      case "perms_list": {
        if (!isGlobalAdmin) return json({ error: "只有任務管理員可以管理權限。" }, 403);
        const have: Record<string, Set<string>> = {};
        const ids = new Set<string>(Array.isArray(body.extra_user_ids) ? body.extra_user_ids : []);
        for (const [k, table] of Object.entries(PERM_TABLES)) {
          const { data } = await supabase.from(table).select("user_id");
          have[k] = new Set((data || []).map((r: any) => r.user_id));
          (data || []).forEach((r: any) => ids.add(r.user_id));
        }
        const users: Record<string, string> = {};
        if (ids.size > 0) {
          const { data } = await supabase.from("users").select("id, display_name").in("id", [...ids]);
          (data || []).forEach((u: any) => { users[u.id] = u.display_name || "—"; });
        }
        const rows = [...ids].map((id) => ({
          user_id: id, name: users[id] || "—",
          perms: Object.fromEntries(Object.keys(PERM_TABLES).map((k) => [k, have[k].has(id)])),
        })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

        let teams = ["shrine", "general", "resident"], teamTableOk = true;
        const { data: tRows, error: tErr } = await supabase.from("altar_manager_teams").select("team");
        if (tErr) teamTableOk = false; else teams = (tRows || []).map((r: any) => r.team);
        const { data: leaders } = await supabase.from("altar_team_members").select("altar_id, team, user_id")
          .eq("role", "leader").in("team", teams.length ? teams : ["_none"]);
        const { data: altars } = await supabase.from("altars").select("id, name");
        const an: Record<string, string> = {}; (altars || []).forEach((a: any) => { an[a.id] = a.name; });
        const lids = [...new Set((leaders || []).map((l: any) => l.user_id))];
        const ln: Record<string, string> = {};
        if (lids.length) { const { data } = await supabase.from("users").select("id, display_name").in("id", lids); (data || []).forEach((u: any) => { ln[u.id] = u.display_name; }); }
        return json({
          rows, teams, team_table_ok: teamTableOk, me: existingUser.id,
          leaders: (leaders || []).map((l: any) => ({ name: ln[l.user_id] || "—", altar: an[l.altar_id] || "—", team: l.team })),
        });
      }

      case "perms_search_users": {
        if (!isGlobalAdmin) return json({ error: "只有任務管理員可以管理權限。" }, 403);
        const q = String(body.query || "").trim().replace(/[,()%]/g, " ");
        if (!q) return json({ users: [] });
        const { data, error } = await supabase.from("users").select("id, display_name").ilike("display_name", `%${q}%`).limit(15);
        if (error) return json({ error: error.message }, 400);
        return json({ users: data || [] });
      }

      case "perms_set": {
        if (!isGlobalAdmin) return json({ error: "只有任務管理員可以管理權限。" }, 403);
        const table = PERM_TABLES[body.key];
        if (!table || !body.user_id) return json({ error: "Missing fields." }, 400);
        if (body.key === "task" && !body.enabled && body.user_id === existingUser.id) {
          return json({ error: "不能移除自己的任務管理權限（避免把自己鎖在外面）。" }, 400);
        }
        if (body.enabled) {
          const { error } = await supabase.from(table).upsert({ user_id: body.user_id }, { onConflict: "user_id" });
          if (error) return json({ error: error.message }, 400);
        } else {
          const { error } = await supabase.from(table).delete().eq("user_id", body.user_id);
          if (error) return json({ error: error.message }, 400);
        }
        return json({ ok: true });
      }

      case "perms_set_team": {
        if (!isGlobalAdmin) return json({ error: "只有任務管理員可以管理權限。" }, 403);
        if (!TEAM_KEYS.includes(body.team)) return json({ error: "Invalid team." }, 400);
        const { error } = body.enabled
          ? await supabase.from("altar_manager_teams").upsert({ team: body.team })
          : await supabase.from("altar_manager_teams").delete().eq("team", body.team);
        if (error) return json({ error: error.message + "（請先執行 SQL/53-altar-manager-teams.sql）" }, 400);
        return json({ ok: true });
      }

      // ---- Upcoming instances (next 90 days) with sub-task status, for assigning ----
      case "list_upcoming": {
        const from = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 8 * 3600 * 1000 + 90 * 86400000).toISOString().slice(0, 10);
        await supabase.rpc("ensure_task_instances", { p_from: from, p_to: to });

        const { data: insts, error: instErr } = await supabase
          .from("task_instances")
          .select("id, occurrence_date, template_id, task_templates ( title, place, is_active )")
          .gte("occurrence_date", from).lte("occurrence_date", to)
          .order("occurrence_date", { ascending: true });
        if (instErr) return json({ error: instErr.message }, 400);
        const okTpl = await manageableTemplateIds([...new Set((insts || []).map((i: any) => i.template_id))] as string[]);
        const active = (insts || []).filter((i: any) => i.task_templates && i.task_templates.is_active && okTpl.has(i.template_id));
        if (active.length === 0) return json({ instances: [] });

        const tplIds = [...new Set(active.map((i: any) => i.template_id))];
        const instIds = active.map((i: any) => i.id);
        const { data: subs } = await supabase
          .from("task_subtask_templates").select("id, template_id, title, sort_order, section, slots, time_label, place, owner_note, checker")
          .in("template_id", tplIds).order("sort_order", { ascending: true });
        const { data: comps } = await supabase
          .from("task_subtask_completions")
          .select("id, subtask_template_id, instance_id, status, assigned_user_id, users!assigned_user_id ( display_name )")
          .in("instance_id", instIds);

        const instances = active
          .map((i: any) => ({
            instance_id: i.id,
            template_id: i.template_id,
            date: i.occurrence_date,
            title: i.task_templates.title,
            place: i.task_templates.place || null,
            subtasks: (subs || []).filter((x: any) => x.template_id === i.template_id).map((x: any) => {
              const rows = (comps || []).filter((k: any) => k.subtask_template_id === x.id && k.instance_id === i.id);
              const people = rows
                .filter((k: any) => k.status === "taken" || k.status === "completed")
                .map((k: any) => ({ completion_id: k.id, user_id: k.assigned_user_id, name: k.users?.display_name || "—", status: k.status }));
              return {
                subtask_template_id: x.id,
                title: x.title,
                section: x.section || null,
                time_label: x.time_label || null,
                place: x.place || null,
                owner_note: x.owner_note || null,
                checker: x.checker || null,
                slots: Math.max(1, x.slots || 1),
                people,
              };
            }),
          }))
          .filter((i: any) => i.subtasks.length > 0);
        return json({ instances });
      }

      // ---- Find people to assign; flags whether each can see the job ----
      case "search_users": {
        const q = String(body.query || "").trim().replace(/[,()%]/g, " ");
        if (!q || !body.template_id) return json({ users: [] });
        if (!(await canManageTemplate(body.template_id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
        const { data: found, error } = await supabase
          .from("users").select("id, display_name")
          .ilike("display_name", `%${q}%`).limit(15);
        if (error) return json({ error: error.message }, 400);
        const users = [];
        for (const u of found || []) {
          users.push({ ...u, eligible: await userCanSeeTemplate(body.template_id, u.id) });
        }
        return json({ users });
      }

      // ---- Assign (or re-assign) one sub-task on one instance ----
      case "assign_subtask": {
        const { instance_id, subtask_template_id, user_id, force } = body;
        if (!instance_id || !subtask_template_id || !user_id) return json({ error: "Missing fields." }, 400);
        const { data: inst } = await supabase.from("task_instances").select("id, template_id").eq("id", instance_id).maybeSingle();
        const { data: sub } = await supabase.from("task_subtask_templates").select("id, template_id, slots").eq("id", subtask_template_id).maybeSingle();
        if (!inst || !sub || sub.template_id !== inst.template_id) return json({ error: "找不到這個子項目。" }, 404);
        if (!(await canManageTemplate(inst.template_id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
        if (!force && !(await userCanSeeTemplate(inst.template_id, user_id))) {
          return json({ error: "此人不在這項工作的適用群組／壇內。", not_eligible: true }, 409);
        }
        const slots = Math.max(1, (sub as any).slots || 1);
        const { data: rowsRaw } = await supabase
          .from("task_subtask_completions").select("id, status, assigned_user_id")
          .eq("instance_id", instance_id).eq("subtask_template_id", subtask_template_id);
        const rows = rowsRaw || [];
        const mine = rows.find((r: any) => r.assigned_user_id === user_id);
        if (mine?.status === "taken") return json({ ok: true });
        if (mine?.status === "completed") return json({ error: "這個人已經完成這個子項目了。" }, 409);
        const live = rows.filter((r: any) => r.status === "taken" || r.status === "completed").length;
        if (live >= slots) return json({ error: "這個子項目名額已滿（" + slots + " 人）。可先取消其中一位，或調高人數。" }, 409);
        const reuse = mine || rows.find((r: any) => r.status === "incomplete");
        if (reuse) {
          const { error } = await supabase.from("task_subtask_completions")
            .update({ assigned_user_id: user_id, status: "taken", completed_by: null, completed_at: null }).eq("id", (reuse as any).id);
          if (error) return json({ error: error.message }, 400);
        } else {
          const { error } = await supabase.from("task_subtask_completions")
            .insert({ instance_id, subtask_template_id, assigned_user_id: user_id, status: "taken" });
          if (error) return json({ error: error.message }, 400);
        }
        return json({ ok: true });
      }

      // ---- Take an assignment back (returns to 未指派) ----
      case "unassign_subtask": {
        if (!body.completion_id) return json({ error: "Missing completion_id." }, 400);
        if (!isGlobalAdmin) {
          const { data: comp } = await supabase.from("task_subtask_completions").select("instance_id").eq("id", body.completion_id).maybeSingle();
          const { data: inst2 } = comp ? await supabase.from("task_instances").select("template_id").eq("id", comp.instance_id).maybeSingle() : { data: null };
          if (!inst2 || !(await canManageTemplate(inst2.template_id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
        }
        const { error } = await supabase.from("task_subtask_completions").delete().eq("id", body.completion_id).eq("status", "taken");
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- List every job template, with its subtasks + groups ----
      case "list_templates": {
        const { data: templates, error } = await supabase
          .from("task_templates")
          .select("*")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        let visibleTemplates = templates || [];
        if (!isGlobalAdmin) {
          const okIds = await manageableTemplateIds(visibleTemplates.map((t: any) => t.id));
          visibleTemplates = visibleTemplates.filter((t: any) => okIds.has(t.id));
        }
        const templateIds = visibleTemplates.map((t: any) => t.id);
        let subtasks: any[] = [];
        let templateGroups: any[] = [];

        if (templateIds.length > 0) {
          const { data: subs, error: subsErr } = await supabase
            .from("task_subtask_templates")
            .select("id, template_id, title, sort_order, section, slots, time_label, place, owner_note, checker")
            .in("template_id", templateIds)
            .order("sort_order", { ascending: true });
          if (subsErr) return json({ error: subsErr.message }, 400);
          subtasks = subs || [];

          const { data: tg, error: tgErr } = await supabase
            .from("task_template_groups")
            .select("template_id, group_id")
            .in("template_id", templateIds);
          if (tgErr) return json({ error: tgErr.message }, 400);
          templateGroups = tg || [];
        }

        const result = visibleTemplates.map((t: any) => ({
          ...t,
          subtasks: subtasks.filter((s: any) => s.template_id === t.id),
          group_ids: templateGroups.filter((g: any) => g.template_id === t.id).map((g: any) => g.group_id),
        }));
        return json({ templates: result });
      }

      // ---- All altars (id, name, parent) for the 所屬壇 picker ----
      case "list_altars": {
        const { data, error } = await supabase.from("altars").select("id, name, parent_id").order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ altars: data || [] });
      }

      // ---- All groups, for the checkbox list ----
      case "list_groups": {
        // altar_id/team/altars(name) let tasks-admin.html section the
        // checkbox list by altar, so a leader picks their own altar's
        // group instead of hunting through a flat, ever-growing list
        // (or worse, leaving it unchecked and going public by mistake).
        const { data, error } = await supabase
          .from("task_groups")
          .select("id, name, altar_id, team, altars ( name )")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ groups: (data || []).filter((g: any) => isGlobalAdmin || ledGroupIds.includes(g.id)) });
      }

      // ---- All saved job presets ----
      case "list_presets": {
        const { data, error } = await supabase
          .from("task_job_presets")
          .select("*")
          .order("name", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        const presetsOk = (data || []).filter((p: any) => isGlobalAdmin || (Array.isArray(p.group_ids) && p.group_ids.length > 0 && p.group_ids.every((g: string) => ledGroupIds.includes(g))));
        return json({ presets: presetsOk });
      }

      // ---- Create or update a job template ----
      case "save_template": {
        const {
          id, title, description, recurrence, recurrence_detail,
          slots_per_instance, place, start_date, end_date, subtasks, group_ids,
        } = body;

        const cleanTitle = (title || "").trim();
        if (!cleanTitle) return json({ error: "請填寫工作名稱。" }, 400);
        if (!isGlobalAdmin) {
          // Leaders: must keep the job inside their own group(s).
          const want = Array.isArray(group_ids) ? group_ids : [];
          if (want.length === 0 || !want.every((g: string) => ledGroupIds.includes(g))) {
            return json({ error: "請限定在您所屬壇・組的群組（至少勾選一個，且不能勾選其他群組）。" }, 403);
          }
          if (id && !(await canManageTemplate(id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
          delete body.is_featured;
          if (body.altar_id && !ledAltarIds.includes(body.altar_id)) delete body.altar_id;
        }
        if (!RECURRENCES.includes(recurrence)) return json({ error: "頻率不正確。" }, 400);

        let cleanStart = start_date || null;
        let cleanEnd = end_date || null;
        if (recurrence === "once") {
          if (!cleanStart) return json({ error: "請選擇單次工作的日期。" }, 400);
          cleanEnd = cleanStart;
        } else if (cleanStart && cleanEnd && cleanStart > cleanEnd) {
          return json({ error: "開始日期不能晚於結束日期。" }, 400);
        }

        const payload: Record<string, unknown> = {
          title: cleanTitle,
          description: description ? String(description).trim() : null,
          recurrence,
          recurrence_detail: recurrence_detail && typeof recurrence_detail === "object" ? recurrence_detail : {},
          slots_per_instance: Math.max(1, parseInt(String(slots_per_instance), 10) || 1),
          place: place ? String(place).trim() : null,
          start_date: cleanStart,
          end_date: cleanEnd,
          ...("is_featured" in body ? { is_featured: !!body.is_featured } : {}),
        };
        if ("altar_id" in body) payload.altar_id = body.altar_id || null;

        let templateId = id || null;
        if (templateId) {
          const { error } = await supabase.from("task_templates").update(payload).eq("id", templateId);
          if (error) return json({ error: error.message }, 400);
        } else {
          payload.is_active = true;
          const { data, error } = await supabase.from("task_templates").insert(payload).select().single();
          if (error) return json({ error: error.message }, 400);
          templateId = data.id;
        }

        // Sync subtasks: same diff pattern as the dashboard — update
        // rows that already had a DB id, insert new ones, delete
        // ones removed from the list, so completion history for kept
        // rows survives a save.
        const rows = (Array.isArray(subtasks) ? subtasks : [])
          .map((s: any, idx: number) => ({
            id: s && s.id ? s.id : null,
            title: ((s && s.title) || "").trim(),
            section: ((s && s.section) || "").trim().slice(0, 60) || null,
            slots: Math.max(1, Math.min(50, parseInt(String(s && s.slots), 10) || 1)),
            time_label: ((s && s.time_label) || "").trim().slice(0, 40) || null,
            place: ((s && s.place) || "").trim().slice(0, 60) || null,
            owner_note: ((s && s.owner_note) || "").trim().slice(0, 80) || null,
            checker: ((s && s.checker) || "").trim().slice(0, 80) || null,
            sort_order: idx,
          }))
          .filter((r: any) => r.title);

        const { data: existingSubs } = await supabase
          .from("task_subtask_templates")
          .select("id")
          .eq("template_id", templateId);
        const existingIds = (existingSubs || []).map((s: any) => s.id);
        const keptIds = rows.filter((r: any) => r.id).map((r: any) => r.id);
        const toDeleteSubs = existingIds.filter((eid: string) => !keptIds.includes(eid));

        if (toDeleteSubs.length > 0) {
          await supabase.from("task_subtask_templates").delete().in("id", toDeleteSubs);
        }
        for (const row of rows) {
          if (row.id) {
            await supabase.from("task_subtask_templates").update({ title: row.title, section: row.section, slots: row.slots, time_label: row.time_label, place: row.place, owner_note: row.owner_note, checker: row.checker, sort_order: row.sort_order }).eq("id", row.id);
          } else {
            await supabase.from("task_subtask_templates").insert({ template_id: templateId, title: row.title, section: row.section, slots: row.slots, time_label: row.time_label, place: row.place, owner_note: row.owner_note, checker: row.checker, sort_order: row.sort_order });
          }
        }

        // Sync group links: plain join table, just diff and apply.
        const wantGroupIds = Array.isArray(group_ids) ? group_ids : [];
        const { data: existingLinks } = await supabase
          .from("task_template_groups")
          .select("group_id")
          .eq("template_id", templateId);
        const existingGroupIds = (existingLinks || []).map((r: any) => r.group_id);
        const toRemoveGroups = existingGroupIds.filter((gid: string) => !wantGroupIds.includes(gid));
        const toAddGroups = wantGroupIds.filter((gid: string) => !existingGroupIds.includes(gid));

        if (toRemoveGroups.length > 0) {
          await supabase.from("task_template_groups").delete().eq("template_id", templateId).in("group_id", toRemoveGroups);
        }
        if (toAddGroups.length > 0) {
          await supabase.from("task_template_groups").insert(toAddGroups.map((group_id: string) => ({ template_id: templateId, group_id })));
        }

        return json({ ok: true, template_id: templateId });
      }

      // ---- Activate/deactivate a job template ----
      case "toggle_template_active": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        if (!(await canManageTemplate(id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
        const { data: tpl } = await supabase.from("task_templates").select("is_active").eq("id", id).maybeSingle();
        if (!tpl) return json({ error: "This job no longer exists." }, 404);
        const { error } = await supabase.from("task_templates").update({ is_active: !tpl.is_active }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Delete a job template ----
      case "delete_template": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        if (!(await canManageTemplate(id))) return json({ error: "您沒有管理此工作的權限。" }, 403);
        const { error } = await supabase.from("task_templates").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Save (create or overwrite by name) a job preset ----
      case "save_preset": {
        const { name, title, description, place, start_date, end_date, subtasks, group_ids } = body;
        const cleanName = (name || "").trim();
        const cleanTitle = (title || "").trim();
        if (!cleanName) return json({ error: "請填寫範本名稱。" }, 400);
        if (!cleanTitle) return json({ error: "請填寫工作名稱。" }, 400);
        if (!isGlobalAdmin) {
          const want = Array.isArray(group_ids) ? group_ids : [];
          if (want.length === 0 || !want.every((g: string) => ledGroupIds.includes(g))) {
            return json({ error: "範本需限定在您所屬壇・組的群組。" }, 403);
          }
          const { data: old } = await supabase.from("task_job_presets").select("group_ids").eq("name", cleanName).maybeSingle();
          if (old && !(Array.isArray(old.group_ids) && old.group_ids.length > 0 && old.group_ids.every((g: string) => ledGroupIds.includes(g)))) {
            return json({ error: "已有同名範本，您沒有權限覆蓋。" }, 403);
          }
        }

        const payload = {
          name: cleanName,
          title: cleanTitle,
          description: description ? String(description).trim() : null,
          place: place ? String(place).trim() : null,
          start_date: start_date || null,
          end_date: end_date || null,
          subtasks: (Array.isArray(subtasks) ? subtasks : [])
            .map((s: any) => ({ title: ((s && s.title) || "").trim(), section: ((s && s.section) || "").trim().slice(0, 60) || null, slots: Math.max(1, Math.min(50, parseInt(String(s && s.slots), 10) || 1)),
              time_label: ((s && s.time_label) || "").trim().slice(0, 40) || null,
              place: ((s && s.place) || "").trim().slice(0, 60) || null,
              owner_note: ((s && s.owner_note) || "").trim().slice(0, 80) || null,
              checker: ((s && s.checker) || "").trim().slice(0, 80) || null }))
            .filter((s: any) => s.title),
          group_ids: Array.isArray(group_ids) ? group_ids : [],
          updated_at: new Date().toISOString(),
        };

        const { error } = await supabase.from("task_job_presets").upsert(payload, { onConflict: "name" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Delete a job preset ----
      case "delete_preset": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        if (!isGlobalAdmin) {
          const { data: pr } = await supabase.from("task_job_presets").select("group_ids").eq("id", id).maybeSingle();
          if (!pr || !(Array.isArray(pr.group_ids) && pr.group_ids.length > 0 && pr.group_ids.every((g: string) => ledGroupIds.includes(g)))) {
            return json({ error: "您沒有權限刪除此範本。" }, 403);
          }
        }
        const { error } = await supabase.from("task_job_presets").delete().eq("id", id);
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

