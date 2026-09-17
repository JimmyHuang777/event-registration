// =========================================================
// SUPABASE EDGE FUNCTION: tasks-api
//
// The write path for the task roster, same security pattern as
// registrant-api: the browser sends LINE's ID token, this function
// verifies it directly with LINE's servers before trusting anything.
//
// Actions:
//   list_tasks    — upcoming task instances in a date range, with
//                    how many slots are filled and whether the
//                    caller has claimed each one
//   claim_task    — claim an open slot on one instance
//   release_task  — cancel the caller's own claim
//
// DEPLOY: this repo's GitHub Actions workflow deploys it automatically
// on push to supabase/functions/tasks-api/** (same as registrant-api).
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
        toDate.setDate(toDate.getDate() + (body.days || 30));
        const to = toDate.toISOString().slice(0, 10);

        // Lazily generate any missing instances for this window —
        // idempotent, so calling this on every page load is safe.
        await supabase.rpc("ensure_task_instances", { p_from: from, p_to: to });

        const { data: instances, error: instErr } = await supabase
          .from("task_instances")
          .select("id, occurrence_date, template_id, task_templates ( id, title, description, recurrence, slots_per_instance )")
          .gte("occurrence_date", from)
          .lte("occurrence_date", to)
          .order("occurrence_date", { ascending: true });

        if (instErr) return json({ error: instErr.message }, 400);

        const instanceIds = (instances || []).map((i: any) => i.id);
        let assignments: any[] = [];
        if (instanceIds.length > 0) {
          const { data: asg, error: asgErr } = await supabase
            .from("task_assignments")
            .select("id, instance_id, user_id, status, users ( display_name, line_picture_url )")
            .in("instance_id", instanceIds)
            .neq("status", "cancelled");
          if (asgErr) return json({ error: asgErr.message }, 400);
          assignments = asg || [];
        }

        const result = (instances || []).map((inst: any) => {
          const forInstance = assignments.filter((a) => a.instance_id === inst.id);
          const mine = existingUser ? forInstance.find((a) => a.user_id === existingUser.id) : null;
          return {
            instance_id: inst.id,
            occurrence_date: inst.occurrence_date,
            title: inst.task_templates?.title,
            description: inst.task_templates?.description,
            recurrence: inst.task_templates?.recurrence,
            slots_total: inst.task_templates?.slots_per_instance || 1,
            slots_filled: forInstance.length,
            assignees: forInstance.map((a) => ({ display_name: a.users?.display_name, picture: a.users?.line_picture_url })),
            my_assignment_id: mine ? mine.id : null,
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

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Server error. Please try again." }, 500);
  }
});
