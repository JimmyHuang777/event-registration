// =========================================================
// SUPABASE EDGE FUNCTION: tasks-api
//
// The write path for the task roster, same security pattern as
// registrant-api: the browser sends LINE's ID token, this function
// verifies it directly with LINE's servers before trusting anything.
//
// Actions:
//   list_tasks       — upcoming task instances in a date range, with
//                       fill status, place, subtask claim/completion
//                       state, and the caller's own assignment status
//   claim_task       — claim an open slot on one instance
//   release_task     — cancel the caller's own claim
//   complete_task    — mark the caller's own assignment 'completed'
//                       (requires every subtask on the instance to
//                       already be 'completed', if it has any)
//   claim_subtask    — take one subtask on one instance (only for
//                       someone assigned to that instance)
//   release_subtask  — give up a subtask the caller took (only if
//                       not yet marked done)
//   complete_subtask — mark/unmark one of the caller's own taken
//                       subtasks as done
//
// DEPLOY: this repo's GitHub Actions workflow deploys it automatically
// on push to supabase/functions/tasks-api/** (same as registrant-api).
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// A template with no rows in task_template_groups is public. A
// template WITH rows there is only visible to someone who belongs to
// at least one of those groups. Reused by every write action so a
// group restriction can't be bypassed by calling an action directly
// with a known instance_id.
async function isTemplateVisible(templateId: string, existingUser: { id: string } | null) {
  const { data: groupLinks } = await supabase
    .from("task_template_groups")
    .select("group_id")
    .eq("template_id", templateId);

  if (!groupLinks || groupLinks.length === 0) return true; // public template

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
      // ---- List upcoming task instances, with fill status ----
      case "list_tasks": {
        const from = body.from_date || todayStr();
        const toDate = new Date(from);
        toDate.setDate(toDate.getDate() + (body.days || 90));
        const to = toDate.toISOString().slice(0, 10);

        // Lazily generate any missing instances for this window —
        // idempotent, so calling this on every page load is safe.
        await supabase.rpc("ensure_task_instances", { p_from: from, p_to: to });

        const { data: instances, error: instErr } = await supabase
          .from("task_instances")
          .select("id, occurrence_date, template_id, task_templates ( id, title, description, place, recurrence, slots_per_instance )")
          .gte("occurrence_date", from)
          .lte("occurrence_date", to)
          .order("occurrence_date", { ascending: true });

        if (instErr) return json({ error: instErr.message }, 400);

        // ---- Group visibility ----
        // A template with no rows in task_template_groups is public
        // (visible to everyone). A template WITH rows there is only
        // visible to someone who belongs to at least one of those
        // groups.
        const allTemplateIds = [...new Set((instances || []).map((i: any) => i.template_id))];
        let visibleTemplateIds = new Set(allTemplateIds);

        if (allTemplateIds.length > 0) {
          const { data: templateGroups, error: tgErr } = await supabase
            .from("task_template_groups")
            .select("template_id, group_id")
            .in("template_id", allTemplateIds);
          if (tgErr) return json({ error: tgErr.message }, 400);

          const restrictedTemplateIds = new Set((templateGroups || []).map((r: any) => r.template_id));
          if (restrictedTemplateIds.size > 0) {
            let myGroupIds = new Set<string>();
            if (existingUser) {
              const { data: myGroups, error: mgErr } = await supabase
                .from("task_group_members")
                .select("group_id")
                .eq("user_id", existingUser.id);
              if (mgErr) return json({ error: mgErr.message }, 400);
              myGroupIds = new Set((myGroups || []).map((r: any) => r.group_id));
            }

            visibleTemplateIds = new Set(
              allTemplateIds.filter((tid: string) => {
                if (!restrictedTemplateIds.has(tid)) return true; // public template
                const groupsForTemplate = (templateGroups || []).filter((r: any) => r.template_id === tid);
                return groupsForTemplate.some((r: any) => myGroupIds.has(r.group_id));
              })
            );
          }
        }

        const visibleInstances = (instances || []).filter((i: any) => visibleTemplateIds.has(i.template_id));

        const instanceIds = visibleInstances.map((i: any) => i.id);
        const templateIds = [...new Set(visibleInstances.map((i: any) => i.template_id))];

        let assignments: any[] = [];
        let subtaskTemplates: any[] = [];
        let subtaskState: any[] = [];

        if (instanceIds.length > 0) {
          const { data: asg, error: asgErr } = await supabase
            .from("task_assignments")
            .select("id, instance_id, user_id, status, users ( display_name, line_picture_url )")
            .in("instance_id", instanceIds)
            .neq("status", "cancelled");
          if (asgErr) return json({ error: asgErr.message }, 400);
          assignments = asg || [];

          const { data: subs, error: subErr } = await supabase
            .from("task_subtask_completions")
            .select("id, subtask_template_id, instance_id, assigned_user_id, status, users!assigned_user_id ( display_name )")
            .in("instance_id", instanceIds);
          if (subErr) return json({ error: subErr.message }, 400);
          subtaskState = subs || [];
        }

        if (templateIds.length > 0) {
          const { data: subs, error: subsErr } = await supabase
            .from("task_subtask_templates")
            .select("id, template_id, title, sort_order")
            .in("template_id", templateIds)
            .order("sort_order", { ascending: true });
          if (subsErr) return json({ error: subsErr.message }, 400);
          subtaskTemplates = subs || [];
        }

        const result = visibleInstances.map((inst: any) => {
          const forInstance = assignments.filter((a) => a.instance_id === inst.id);
          const mine = existingUser ? forInstance.find((a) => a.user_id === existingUser.id) : null;

          const templateSubtasks = subtaskTemplates.filter((s) => s.template_id === inst.template_id);
          const subtasks = templateSubtasks.map((s) => {
            const state = subtaskState.find(
              (c) => c.subtask_template_id === s.id && c.instance_id === inst.id
            );
            return {
              subtask_template_id: s.id,
              title: s.title,
              status: state ? state.status : "unassigned", // 'unassigned' | 'taken' | 'completed'
              assigned_name: state ? state.users?.display_name || null : null,
              assigned_to_me: !!(state && existingUser && state.assigned_user_id === existingUser.id),
            };
          });

          return {
            instance_id: inst.id,
            occurrence_date: inst.occurrence_date,
            title: inst.task_templates?.title,
            description: inst.task_templates?.description,
            place: inst.task_templates?.place || null,
            recurrence: inst.task_templates?.recurrence,
            slots_total: inst.task_templates?.slots_per_instance || 1,
            slots_filled: forInstance.length,
            assignees: forInstance.map((a) => ({ display_name: a.users?.display_name, picture: a.users?.line_picture_url })),
            my_assignment_id: mine ? mine.id : null,
            my_assignment_status: mine ? mine.status : null,
            // Any visible task's subtasks can be claimed directly — this
            // list only ever contains tasks the caller is allowed to see,
            // so visibility (already enforced above) is the only real gate.
            can_claim_subtasks: true,
            subtasks,
          };
        });

        return json({ user: existingUser || null, tasks: result });
      }

      // ---- Claim an open slot ----
      case "claim_task": {
        const { instance_id, display_name, phone } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);

        // First-time claimers need a profile — same as event registration.
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .upsert(
            {
              line_user_id: lineUserId,
              display_name: display_name || existingUser?.display_name || claims.name || "LINE User",
              phone: phone || existingUser?.phone || null,
              line_picture_url: claims.picture || existingUser?.line_picture_url || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "line_user_id" }
          )
          .select()
          .single();
        if (userErr) return json({ error: userErr.message }, 400);

        // Check the slot is actually open (race-condition-safe enough for
        // this scale: re-checked right before insert).
        const { data: inst } = await supabase
          .from("task_instances")
          .select("id, template_id, task_templates ( slots_per_instance )")
          .eq("id", instance_id)
          .maybeSingle();
        if (!inst) return json({ error: "This task no longer exists." }, 404);

        if (!(await isTemplateVisible((inst as any).template_id, existingUser))) {
          return json({ error: "這項工作不開放給您的群組。This task isn't open to your group." }, 403);
        }

        const { data: currentAssignments } = await supabase
          .from("task_assignments")
          .select("id")
          .eq("instance_id", instance_id)
          .neq("status", "cancelled");

        const slotsTotal = (inst as any).task_templates?.slots_per_instance || 1;
        if ((currentAssignments || []).length >= slotsTotal) {
          return json({ error: "這個時段已經額滿了。This slot is already full." }, 409);
        }

        // No plain unique constraint on (instance_id, user_id) — only a
        // partial one that excludes cancelled rows — so we check-then-
        // write by hand rather than relying on upsert's ON CONFLICT,
        // which can't target a partial index this way.
        const { data: priorRow } = await supabase
          .from("task_assignments")
          .select("id, status")
          .eq("instance_id", instance_id)
          .eq("user_id", userRow.id)
          .maybeSingle();

        let assignment;
        if (priorRow && priorRow.status !== "cancelled") {
          assignment = priorRow; // already claimed — idempotent, not an error
        } else if (priorRow) {
          const { data, error } = await supabase
            .from("task_assignments")
            .update({ status: "claimed", assigned_by: "self", updated_at: new Date().toISOString() })
            .eq("id", priorRow.id)
            .select()
            .single();
          if (error) return json({ error: error.message }, 400);
          assignment = data;
        } else {
          const { data, error } = await supabase
            .from("task_assignments")
            .insert({ instance_id, user_id: userRow.id, status: "claimed", assigned_by: "self" })
            .select()
            .single();
          if (error) return json({ error: error.message }, 400);
          assignment = data;
        }

        return json({ assignment });
      }

      // ---- Release the caller's own claim ----
      case "release_task": {
        const { assignment_id } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!assignment_id) return json({ error: "Missing assignment_id." }, 400);

        const { data: existingAsg } = await supabase
          .from("task_assignments")
          .select("id, user_id")
          .eq("id", assignment_id)
          .maybeSingle();

        if (!existingAsg || existingAsg.user_id !== existingUser.id) {
          return json({ error: "You can only release your own tasks." }, 403);
        }

        const { data, error } = await supabase
          .from("task_assignments")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", assignment_id)
          .select()
          .single();

        if (error) return json({ error: error.message }, 400);
        return json({ assignment: data });
      }

      // ---- Mark the caller's own assignment as completed ----
      case "complete_task": {
        const { assignment_id } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!assignment_id) return json({ error: "Missing assignment_id." }, 400);

        const { data: existingAsg } = await supabase
          .from("task_assignments")
          .select("id, user_id, instance_id, status")
          .eq("id", assignment_id)
          .maybeSingle();

        if (!existingAsg || existingAsg.user_id !== existingUser.id) {
          return json({ error: "You can only complete your own tasks." }, 403);
        }
        if (!["claimed", "assigned"].includes(existingAsg.status)) {
          return json({ error: "This task isn't in a state that can be marked complete." }, 400);
        }

        // Every subtask on this instance (if it has any) must already
        // be checked off before the task itself can be completed.
        const { data: inst } = await supabase
          .from("task_instances")
          .select("id, template_id")
          .eq("id", existingAsg.instance_id)
          .maybeSingle();

        if (inst) {
          const { data: subTemplates } = await supabase
            .from("task_subtask_templates")
            .select("id")
            .eq("template_id", (inst as any).template_id);

          if (subTemplates && subTemplates.length > 0) {
            const { data: doneRows } = await supabase
              .from("task_subtask_completions")
              .select("subtask_template_id")
              .eq("instance_id", existingAsg.instance_id)
              .eq("status", "completed");

            const doneIds = new Set((doneRows || []).map((r: any) => r.subtask_template_id));
            const allDone = subTemplates.every((s: any) => doneIds.has(s.id));
            if (!allDone) {
              return json({ error: "請先完成所有子項目才能標記此任務完成。Please finish every subtask first." }, 400);
            }
          }
        }

        const { data, error } = await supabase
          .from("task_assignments")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", assignment_id)
          .select()
          .single();

        if (error) return json({ error: error.message }, 400);
        return json({ assignment: data });
      }

      // ---- Take one subtask on one instance ----
      case "claim_subtask": {
        const { instance_id, subtask_template_id } = body;
        if (!instance_id || !subtask_template_id) {
          return json({ error: "Missing instance_id or subtask_template_id." }, 400);
        }

        // Subtasks no longer require claiming the parent job first —
        // just visibility (same group rule as the job itself). A
        // first-time claimer gets a minimal profile from their LINE
        // name, same as claiming a job does with fuller details.
        let claimerUser = existingUser;
        if (!claimerUser) {
          const { data: newUserRow, error: newUserErr } = await supabase
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
          claimerUser = newUserRow;
        }

        const { data: inst } = await supabase
          .from("task_instances")
          .select("id, template_id")
          .eq("id", instance_id)
          .maybeSingle();
        if (!inst) return json({ error: "This task no longer exists." }, 404);

        if (!(await isTemplateVisible((inst as any).template_id, claimerUser))) {
          return json({ error: "這項工作不開放給您的群組。This task isn't open to your group." }, 403);
        }

        const { data: existingRow } = await supabase
          .from("task_subtask_completions")
          .select("id, assigned_user_id")
          .eq("instance_id", instance_id)
          .eq("subtask_template_id", subtask_template_id)
          .maybeSingle();

        if (existingRow) {
          if (existingRow.assigned_user_id === claimerUser.id) {
            return json({ ok: true }); // already mine — idempotent
          }
          return json({ error: "這個子項目已經有人認領了。This subtask has already been taken." }, 409);
        }

        const { error } = await supabase
          .from("task_subtask_completions")
          .insert({ instance_id, subtask_template_id, assigned_user_id: claimerUser.id, status: "taken" });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Give up a subtask the caller took (must not be done yet) ----
      case "release_subtask": {
        const { instance_id, subtask_template_id } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!instance_id || !subtask_template_id) {
          return json({ error: "Missing instance_id or subtask_template_id." }, 400);
        }

        const { data: existingRow } = await supabase
          .from("task_subtask_completions")
          .select("id, assigned_user_id")
          .eq("instance_id", instance_id)
          .eq("subtask_template_id", subtask_template_id)
          .maybeSingle();

        if (!existingRow) return json({ ok: true }); // nothing to release
        if (existingRow.assigned_user_id !== existingUser.id) {
          return json({ error: "You can only release a subtask you took yourself." }, 403);
        }

        const { error } = await supabase.from("task_subtask_completions").delete().eq("id", existingRow.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Mark/unmark one of the caller's own taken subtasks as done ----
      case "complete_subtask": {
        const { instance_id, subtask_template_id, completed } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!instance_id || !subtask_template_id) {
          return json({ error: "Missing instance_id or subtask_template_id." }, 400);
        }

        const { data: existingRow } = await supabase
          .from("task_subtask_completions")
          .select("id, assigned_user_id")
          .eq("instance_id", instance_id)
          .eq("subtask_template_id", subtask_template_id)
          .maybeSingle();

        if (!existingRow || existingRow.assigned_user_id !== existingUser.id) {
          return json({ error: "請先認領此子項目。Take this subtask before marking it done." }, 403);
        }

        const { error } = await supabase
          .from("task_subtask_completions")
          .update(
            completed
              ? { status: "completed", completed_by: existingUser.id, completed_at: new Date().toISOString() }
              : { status: "taken", completed_by: null, completed_at: null }
          )
          .eq("id", existingRow.id);
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
