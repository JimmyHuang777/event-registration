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

const RECURRENCES = ["daily", "weekly", "monthly", "once"];

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
    const isAdmin = !!adminRow;

    if (action === "whoami") {
      return json({ user: existingUser, is_admin: isAdmin });
    }

    if (!isAdmin) {
      return json({ error: "您沒有管理工作的權限，請聯繫管理員。You don't have permission to manage jobs." }, 403);
    }

    switch (action) {
      // ---- List every job template, with its subtasks + groups ----
      case "list_templates": {
        const { data: templates, error } = await supabase
          .from("task_templates")
          .select("*")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const templateIds = (templates || []).map((t: any) => t.id);
        let subtasks: any[] = [];
        let templateGroups: any[] = [];

        if (templateIds.length > 0) {
          const { data: subs, error: subsErr } = await supabase
            .from("task_subtask_templates")
            .select("id, template_id, title, sort_order")
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

        const result = (templates || []).map((t: any) => ({
          ...t,
          subtasks: subtasks.filter((s: any) => s.template_id === t.id),
          group_ids: templateGroups.filter((g: any) => g.template_id === t.id).map((g: any) => g.group_id),
        }));
        return json({ templates: result });
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
        return json({ groups: data || [] });
      }

      // ---- All saved job presets ----
      case "list_presets": {
        const { data, error } = await supabase
          .from("task_job_presets")
          .select("*")
          .order("name", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ presets: data || [] });
      }

      // ---- Create or update a job template ----
      case "save_template": {
        const {
          id, title, description, recurrence, recurrence_detail,
          slots_per_instance, place, start_date, end_date, subtasks, group_ids,
        } = body;

        const cleanTitle = (title || "").trim();
        if (!cleanTitle) return json({ error: "請填寫工作名稱。" }, 400);
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
        };

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
            await supabase.from("task_subtask_templates").update({ title: row.title, sort_order: row.sort_order }).eq("id", row.id);
          } else {
            await supabase.from("task_subtask_templates").insert({ template_id: templateId, title: row.title, sort_order: row.sort_order });
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

        const payload = {
          name: cleanName,
          title: cleanTitle,
          description: description ? String(description).trim() : null,
          place: place ? String(place).trim() : null,
          start_date: start_date || null,
          end_date: end_date || null,
          subtasks: (Array.isArray(subtasks) ? subtasks : [])
            .map((s: any) => ({ title: ((s && s.title) || "").trim() }))
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

