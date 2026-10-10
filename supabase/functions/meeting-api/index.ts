// =========================================================
// SUPABASE EDGE FUNCTION: meeting-api
//
// Backs meetings.html — the 溝通共識系統 (Communication /
// Consensus System): recurring review meetings (道務會議、班務
//會議、事務會議、壇務會議, etc). Two roles:
//   - Member       — sees the meetings they're invited to (auto-
//                    invited from the meeting type's group), can
//                    self check-in on the day of, reads the
//                    minutes once posted, and sees/completes any
//                    action items assigned to them.
//   - Meeting Admin — manages meeting types (recurrence/group/
//                     place), records attendance, writes minutes,
//                     and assigns action items. A brand-new,
//                     separate permission list (meeting_admins) —
//                     being a Super Admin does NOT automatically
//                     make someone a Meeting Admin here, mirroring
//                     Car Manager / Lodging Manager / Task Job
//                     Admin.
//
// Actions (member — any registered LINE user):
//   whoami                — registers/looks up the caller's `users`
//                            row, reports is_meeting_admin.
//   list_my_meetings       — the caller's upcoming + recent meeting
//                            instances (auto-generated for a rolling
//                            window), with their own attendance
//                            status.
//   get_meeting            — one meeting instance's detail from the
//                            caller's own point of view: meeting
//                            type info, own attendance row, minutes
//                            (once posted), and the caller's own
//                            action items for that meeting.
//   check_in               — self-mark attended, only on the
//                            meeting's own date.
//   list_my_action_items    — every action item assigned to the
//                            caller, across all meetings.
//   complete_action_item    — caller marks their own assigned item
//                            done.
//
// Actions (Meeting Admin only — gated by meeting_admins):
//   list_groups             — task_groups, for the meeting-type
//                             group picker.
//   list_meeting_types       — every meeting type.
//   save_meeting_type        — create/update a meeting type.
//   delete_meeting_type      — remove a meeting type (cascades).
//   list_upcoming_instances  — instances in a date range (ensures
//                             they're generated first).
//   get_instance_detail      — one instance's full attendee list +
//                             action items, for recording.
//   mark_attendance          — toggle one attendee's attended flag.
//   save_minutes             — write/update an instance's notes and
//                             set its status.
//   add_action_item          — add a follow-up item to an instance.
//   update_action_item_status — admin override of an item's status.
//   delete_action_item        — remove an item.
//   list_all_action_items     — every action item of every assignee
//                               (overview), filter by status / date range.
//   create_adhoc_meeting      — record a meeting that was never scheduled:
//                               creates a one-time meeting type + that day's
//                               instance (invites the group) and returns the
//                               instance id.
//   meeting_stats             — attendance rate per meeting type and per
//                               person + action-item completion, for a
//                               date range. Same definition as the
//                               Dashboard's 統計 tab (see mtComputeStats).
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/meeting-api/**.
// Deployed with --no-verify-jwt (this function does its own auth
// via the LINE ID token — see the workflow file).
// =========================================================

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID")!;
// Same optional Messaging API credential as carpool-api/lodging-api
// — silently skipped if not set yet.
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";

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

// Today's date in Asia/Taipei, as YYYY-MM-DD — used to gate self
// check-in to only the meeting's own day.
function taipeiToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

const RECURRENCES = ["weekly", "monthly", "once"];

const MANAGER_ACTIONS = new Set([
  "list_groups",
  "list_meeting_types",
  "save_meeting_type",
  "delete_meeting_type",
  "list_upcoming_instances",
  "get_instance_detail",
  "mark_attendance",
  "save_minutes",
  "add_action_item",
  "update_action_item_status",
  "delete_action_item",
  "list_all_action_items",
  "meeting_stats",
  "create_adhoc_meeting",
]);

const MAX_RANGE_DAYS = 400;

// PostgREST returns at most 1000 rows per request: page through them all.
// `build` must return a fresh query each call.
async function fetchAll(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const pct = (a: number, b: number) => (b ? Math.round((a * 1000) / b) / 10 : null);

// Stats definition — keep identical to mtComputeStats() in the Dashboard:
//   counted meetings = in range, date <= today, status != cancelled
//   attendance rate  = attended / invited (person-times)
//   action items     = all items in range (cancelled meetings included)
function computeStats(raw: { types: any[]; instances: any[]; attendance: any[]; items: any[] }, today: string) {
  const counted = new Set(raw.instances.filter((i) => i.meeting_date <= today && i.status !== "cancelled").map((i) => i.id));
  const typeName = new Map(raw.types.map((t) => [t.id, t.name]));
  const instType = new Map(raw.instances.map((i) => [i.id, i.meeting_type_id]));
  const byType = new Map<string, any>();
  const byPerson = new Map<string, any>();
  const T = (id: string) => {
    if (!byType.has(id)) byType.set(id, { type_id: id, name: typeName.get(id) || "會議", held: 0, invited: 0, attended: 0 });
    return byType.get(id);
  };
  const P = (id: string, name?: string) => {
    if (!byPerson.has(id)) byPerson.set(id, { user_id: id, name: name || "—", invited: 0, attended: 0, items_open: 0, items_done: 0 });
    return byPerson.get(id);
  };
  raw.instances.forEach((i) => { if (counted.has(i.id)) T(i.meeting_type_id).held++; });
  raw.attendance.forEach((a) => {
    if (!counted.has(a.meeting_instance_id)) return;
    const t = T(instType.get(a.meeting_instance_id));
    const p = P(a.user_id, a.users?.display_name);
    t.invited++; p.invited++;
    if (a.attended) { t.attended++; p.attended++; }
  });
  let open = 0, done = 0;
  raw.items.forEach((it) => {
    if (it.status === "done") done++; else open++;
    if (it.assignee_user_id) {
      const p = P(it.assignee_user_id, it.users?.display_name);
      if (it.status === "done") p.items_done++; else p.items_open++;
    }
  });
  const fin = (o: any) => Object.assign(o, { rate: pct(o.attended, o.invited) });
  const zh = (a: string, b: string) => a.localeCompare(b, "zh-Hant");
  return {
    held: counted.size,
    by_type: [...byType.values()].map(fin).sort((a, b) => zh(a.name, b.name)),
    by_person: [...byPerson.values()].map(fin).sort(
      (a, b) => (b.invited ? 1 : 0) - (a.invited ? 1 : 0) || (a.rate ?? 101) - (b.rate ?? 101) || zh(a.name, b.name),
    ),
    items: { total: open + done, done, open, rate: pct(done, open + done) },
  };
}

async function pushLineNotification(lineUserIds: string[], text: string) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || lineUserIds.length === 0) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: lineUserIds.slice(0, 500), messages: [{ type: "text", text: text.slice(0, 5000) }] }),
    });
  } catch (_err) {
    // Notification is best-effort only.
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

    const { data: managerRow } = await supabase
      .from("meeting_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isManager = !!managerRow;

    if (MANAGER_ACTIONS.has(action) && !isManager) {
      return json({ error: "您沒有會議管理員的權限，請聯繫管理員。You don't have Meeting Admin permission." }, 403);
    }

    switch (action) {
      case "whoami": {
        return json({ user: existingUser, is_meeting_admin: isManager });
      }

      // =====================================================
      // MEMBER ACTIONS
      // =====================================================

      // ---- The caller's own meeting instances, past + upcoming ----
      case "list_my_meetings": {
        const today = taipeiToday();
        const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        await supabase.rpc("ensure_meeting_instances", { p_from: from, p_to: to });

        const { data: myAttendance } = await supabase
          .from("meeting_attendance")
          .select("meeting_instance_id, attended, checked_in_at")
          .eq("user_id", existingUser.id);
        const instanceIds = (myAttendance || []).map((a: any) => a.meeting_instance_id);
        if (instanceIds.length === 0) return json({ meetings: [] });

        const { data: instances } = await supabase
          .from("meeting_instances")
          .select("id, meeting_date, status, notes, meeting_type_id")
          .in("id", instanceIds)
          .gte("meeting_date", from)
          .order("meeting_date", { ascending: true });

        const typeIds = [...new Set((instances || []).map((i: any) => i.meeting_type_id))];
        const { data: types } = typeIds.length
          ? await supabase.from("meeting_types").select("id, name, place").in("id", typeIds)
          : { data: [] };
        const typeById = new Map((types || []).map((t: any) => [t.id, t]));
        const attendanceByInstance = new Map((myAttendance || []).map((a: any) => [a.meeting_instance_id, a]));

        const meetings = (instances || []).map((i: any) => {
          const t = typeById.get(i.meeting_type_id);
          const a = attendanceByInstance.get(i.id);
          return {
            id: i.id,
            meeting_date: i.meeting_date,
            status: i.status,
            type_name: t?.name || "會議",
            place: t?.place || null,
            has_notes: !!i.notes,
            attended: a?.attended || false,
            checked_in_at: a?.checked_in_at || null,
            can_check_in: i.meeting_date === today && i.status !== "cancelled" && !a?.attended,
          };
        });
        return json({ meetings });
      }

      // ---- One meeting's detail, from the caller's own view ----
      case "get_meeting": {
        const { instance_id } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);

        const { data: attRow } = await supabase
          .from("meeting_attendance")
          .select("*")
          .eq("meeting_instance_id", instance_id)
          .eq("user_id", existingUser.id)
          .maybeSingle();
        if (!attRow) return json({ error: "您沒有這場會議的權限。" }, 403);

        const { data: instance } = await supabase
          .from("meeting_instances")
          .select("id, meeting_date, status, notes, meeting_type_id")
          .eq("id", instance_id)
          .maybeSingle();
        if (!instance) return json({ error: "找不到這場會議。" }, 404);

        const { data: type } = await supabase
          .from("meeting_types")
          .select("name, description, place")
          .eq("id", instance.meeting_type_id)
          .maybeSingle();

        const { data: myItems } = await supabase
          .from("meeting_action_items")
          .select("*")
          .eq("meeting_instance_id", instance_id)
          .eq("assignee_user_id", existingUser.id)
          .order("created_at", { ascending: true });

        return json({
          meeting: {
            id: instance.id,
            meeting_date: instance.meeting_date,
            status: instance.status,
            notes: instance.notes,
            type_name: type?.name || "會議",
            description: type?.description || null,
            place: type?.place || null,
          },
          my_attendance: { attended: attRow.attended, checked_in_at: attRow.checked_in_at },
          my_action_items: myItems || [],
        });
      }

      // ---- Self check-in, only on the meeting's own date ----
      case "check_in": {
        const { instance_id } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);

        const { data: instance } = await supabase
          .from("meeting_instances")
          .select("id, meeting_date, status")
          .eq("id", instance_id)
          .maybeSingle();
        if (!instance) return json({ error: "找不到這場會議。" }, 404);
        if (instance.status === "cancelled") return json({ error: "這場會議已取消。" }, 400);
        if (instance.meeting_date !== taipeiToday()) return json({ error: "只能在會議當天簽到。" }, 400);

        const { data: attRow } = await supabase
          .from("meeting_attendance")
          .select("id")
          .eq("meeting_instance_id", instance_id)
          .eq("user_id", existingUser.id)
          .maybeSingle();
        if (!attRow) return json({ error: "您沒有這場會議的權限。" }, 403);

        const { error } = await supabase
          .from("meeting_attendance")
          .update({ attended: true, checked_in_at: new Date().toISOString() })
          .eq("id", attRow.id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Every action item assigned to the caller ----
      case "list_my_action_items": {
        const { data: items } = await supabase
          .from("meeting_action_items")
          .select("*")
          .eq("assignee_user_id", existingUser.id)
          .order("status", { ascending: true })
          .order("created_at", { ascending: false });

        const instanceIds = [...new Set((items || []).map((i: any) => i.meeting_instance_id))];
        const { data: instances } = instanceIds.length
          ? await supabase.from("meeting_instances").select("id, meeting_date, meeting_type_id").in("id", instanceIds)
          : { data: [] };
        const typeIds = [...new Set((instances || []).map((i: any) => i.meeting_type_id))];
        const { data: types } = typeIds.length
          ? await supabase.from("meeting_types").select("id, name").in("id", typeIds)
          : { data: [] };
        const typeById = new Map((types || []).map((t: any) => [t.id, t]));
        const instanceById = new Map((instances || []).map((i: any) => [i.id, i]));

        const enriched = (items || []).map((it: any) => {
          const inst = instanceById.get(it.meeting_instance_id);
          const t = inst ? typeById.get(inst.meeting_type_id) : null;
          return { ...it, meeting_date: inst?.meeting_date || null, meeting_type_name: t?.name || "會議" };
        });
        return json({ action_items: enriched });
      }

      // ---- Caller marks their own assigned item done ----
      case "complete_action_item": {
        const { item_id } = body;
        if (!item_id) return json({ error: "Missing item_id." }, 400);

        const { data: item } = await supabase
          .from("meeting_action_items")
          .select("id, assignee_user_id")
          .eq("id", item_id)
          .maybeSingle();
        if (!item || item.assignee_user_id !== existingUser.id) {
          return json({ error: "您只能完成指派給自己的待辦事項。" }, 403);
        }

        const { error } = await supabase.from("meeting_action_items").update({ status: "done" }).eq("id", item_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // =====================================================
      // MEETING ADMIN ACTIONS — gated by meeting_admins above.
      // =====================================================

      case "list_groups": {
        const { data, error } = await supabase.from("task_groups").select("id, name").order("name", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ groups: data || [] });
      }

      case "list_meeting_types": {
        const { data: types, error } = await supabase.from("meeting_types").select("*").order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const groupIds = [...new Set((types || []).map((t: any) => t.group_id).filter(Boolean))];
        const { data: groups } = groupIds.length
          ? await supabase.from("task_groups").select("id, name").in("id", groupIds)
          : { data: [] };
        const groupById = new Map((groups || []).map((g: any) => [g.id, g.name]));

        return json({
          meeting_types: (types || []).map((t: any) => ({ ...t, group_name: t.group_id ? groupById.get(t.group_id) || null : null })),
        });
      }

      case "save_meeting_type": {
        const { id, name, description, recurrence, recurrence_detail, group_id, place, start_date, end_date, is_active } = body;

        const cleanName = (name || "").trim();
        if (!cleanName) return json({ error: "請填寫會議名稱。" }, 400);
        if (!RECURRENCES.includes(recurrence)) return json({ error: "頻率不正確。" }, 400);
        if (!start_date) return json({ error: "請選擇開始日期。" }, 400);
        if (recurrence === "weekly") {
          const wd = recurrence_detail?.weekday;
          if (wd === undefined || wd === null || wd < 0 || wd > 6) return json({ error: "請選擇星期幾。" }, 400);
        }
        if (recurrence === "monthly") {
          const dom = recurrence_detail?.day_of_month;
          if (!dom || dom < 1 || dom > 31) return json({ error: "請選擇每月幾號。" }, 400);
        }

        const payload: Record<string, unknown> = {
          name: cleanName,
          description: description ? String(description).trim() : null,
          recurrence,
          recurrence_detail: recurrence_detail && typeof recurrence_detail === "object" ? recurrence_detail : {},
          group_id: group_id || null,
          place: place ? String(place).trim() : null,
          start_date,
          end_date: recurrence === "once" ? start_date : end_date || null,
          is_active: is_active !== false,
        };

        if (id) {
          const { error } = await supabase.from("meeting_types").update(payload).eq("id", id);
          if (error) return json({ error: error.message }, 400);
          return json({ success: true, id });
        } else {
          const { data, error } = await supabase.from("meeting_types").insert(payload).select().single();
          if (error) return json({ error: error.message }, 400);
          return json({ success: true, id: data.id });
        }
      }

      case "delete_meeting_type": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("meeting_types").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Instances in a date range (generated on demand) ----
      case "list_upcoming_instances": {
        const from = body.from || taipeiToday();
        const to = body.to || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
        if (from > to) return json({ error: "日期區間不正確。" }, 400);
        if ((new Date(to).getTime() - new Date(from).getTime()) / 86400000 > MAX_RANGE_DAYS) {
          return json({ error: `區間最多 ${MAX_RANGE_DAYS} 天。` }, 400);
        }
        await supabase.rpc("ensure_meeting_instances", { p_from: from, p_to: to });

        // Types + attendance are embedded, so counts can't be cut off by the
        // 1000-row response limit (a long range × a big group easily exceeds it).
        const instances = await fetchAll(() =>
          supabase
            .from("meeting_instances")
            .select("id, meeting_date, status, notes, meeting_type_id, meeting_types(name, place), meeting_attendance(attended)")
            .gte("meeting_date", from)
            .lte("meeting_date", to)
            .order("meeting_date", { ascending: true })
            .order("id", { ascending: true })
        );

        const result = instances.map((i: any) => {
          const rows = i.meeting_attendance || [];
          return {
            id: i.id,
            meeting_date: i.meeting_date,
            status: i.status,
            has_notes: !!i.notes,
            type_name: i.meeting_types?.name || "會議",
            place: i.meeting_types?.place || null,
            invited_count: rows.length,
            attended_count: rows.filter((r: any) => r.attended).length,
          };
        });
        return json({ instances: result });
      }

      // ---- Full detail for recording one meeting ----
      case "get_instance_detail": {
        const { instance_id } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);

        const { data: instance } = await supabase
          .from("meeting_instances")
          .select("*")
          .eq("id", instance_id)
          .maybeSingle();
        if (!instance) return json({ error: "找不到這場會議。" }, 404);

        const { data: type } = await supabase.from("meeting_types").select("*").eq("id", instance.meeting_type_id).maybeSingle();

        const { data: attendance } = await supabase
          .from("meeting_attendance")
          .select("*")
          .eq("meeting_instance_id", instance_id);
        const userIds = [...new Set((attendance || []).map((a: any) => a.user_id))];
        const { data: users } = userIds.length
          ? await supabase.from("users").select("id, display_name").in("id", userIds)
          : { data: [] };
        const userById = new Map((users || []).map((u: any) => [u.id, u]));

        const { data: items } = await supabase
          .from("meeting_action_items")
          .select("*")
          .eq("meeting_instance_id", instance_id)
          .order("created_at", { ascending: true });
        const assigneeIds = [...new Set((items || []).map((i: any) => i.assignee_user_id).filter(Boolean))];
        const { data: assignees } = assigneeIds.length
          ? await supabase.from("users").select("id, display_name").in("id", assigneeIds)
          : { data: [] };
        const assigneeById = new Map((assignees || []).map((u: any) => [u.id, u.display_name]));

        return json({
          instance,
          type_name: type?.name || "會議",
          place: type?.place || null,
          attendees: (attendance || []).map((a: any) => ({
            attendance_id: a.id,
            user_id: a.user_id,
            name: userById.get(a.user_id)?.display_name || "—",
            attended: a.attended,
            checked_in_at: a.checked_in_at,
          })),
          action_items: (items || []).map((i: any) => ({ ...i, assignee_name: i.assignee_user_id ? assigneeById.get(i.assignee_user_id) || "—" : null })),
        });
      }

      case "mark_attendance": {
        const { attendance_id, attended } = body;
        if (!attendance_id) return json({ error: "Missing attendance_id." }, 400);
        const { error } = await supabase
          .from("meeting_attendance")
          .update({ attended: !!attended, checked_in_at: attended ? new Date().toISOString() : null })
          .eq("id", attendance_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "save_minutes": {
        const { instance_id, notes, status } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);
        const payload: Record<string, unknown> = {};
        if (notes !== undefined) payload.notes = notes ? String(notes).trim() : null;
        if (status && ["scheduled", "completed", "cancelled"].includes(status)) payload.status = status;
        const { error } = await supabase.from("meeting_instances").update(payload).eq("id", instance_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "add_action_item": {
        const { instance_id, content, assignee_user_id } = body;
        if (!instance_id) return json({ error: "Missing instance_id." }, 400);
        const cleanContent = (content || "").trim();
        if (!cleanContent) return json({ error: "請填寫待辦事項內容。" }, 400);

        const { data, error } = await supabase
          .from("meeting_action_items")
          .insert({ meeting_instance_id: instance_id, content: cleanContent, assignee_user_id: assignee_user_id || null })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);

        // Best-effort alert to the assignee, if any, via LINE push.
        if (assignee_user_id) {
          try {
            const { data: assigneeUser } = await supabase.from("users").select("line_user_id").eq("id", assignee_user_id).maybeSingle();
            if (assigneeUser?.line_user_id) {
              await pushLineNotification([assigneeUser.line_user_id], `📋 新的待辦事項\n${cleanContent}\n請至會議頁面查看。`);
            }
          } catch (_err) {
            // ignore
          }
        }

        return json({ success: true, item: data });
      }

      case "update_action_item_status": {
        const { item_id, status } = body;
        if (!item_id || !["open", "done"].includes(status)) return json({ error: "Invalid item_id/status." }, 400);
        const { error } = await supabase.from("meeting_action_items").update({ status }).eq("id", item_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "delete_action_item": {
        const { item_id } = body;
        if (!item_id) return json({ error: "Missing item_id." }, 400);
        const { error } = await supabase.from("meeting_action_items").delete().eq("id", item_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Every action item, every assignee (overview) ----
      case "list_all_action_items": {
        const { status, from, to } = body;
        const rows = await fetchAll(() => {
          let q = supabase
            .from("meeting_action_items")
            .select("id, content, status, assignee_user_id, created_at, meeting_instance_id, users(display_name), meeting_instances!inner(meeting_date, meeting_type_id, meeting_types(name))")
            .order("created_at", { ascending: false })
            .order("id", { ascending: true });
          if (status === "open" || status === "done") q = q.eq("status", status);
          if (from) q = q.gte("meeting_instances.meeting_date", from);
          if (to) q = q.lte("meeting_instances.meeting_date", to);
          return q;
        });
        return json({
          action_items: rows.map((r: any) => ({
            id: r.id,
            content: r.content,
            status: r.status,
            assignee_user_id: r.assignee_user_id,
            assignee_name: r.users?.display_name || null,
            meeting_instance_id: r.meeting_instance_id,
            meeting_date: r.meeting_instances?.meeting_date || null,
            meeting_type_name: r.meeting_instances?.meeting_types?.name || "會議",
          })),
        });
      }

      // ---- A meeting that was never scheduled: one-time type + instance ----
      case "create_adhoc_meeting": {
        const { name, date, place, group_id } = body;
        const cleanName = (name || "").trim();
        if (!cleanName) return json({ error: "請填寫會議名稱。" }, 400);
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "請選擇日期。" }, 400);
        const { data: type, error: typeErr } = await supabase
          .from("meeting_types")
          .insert({
            name: cleanName,
            recurrence: "once",
            recurrence_detail: {},
            start_date: date,
            end_date: date,
            group_id: group_id || null,
            place: place ? String(place).trim() : null,
            is_active: true,
          })
          .select()
          .single();
        if (typeErr) return json({ error: typeErr.message }, 400);
        await supabase.rpc("ensure_meeting_instances", { p_from: date, p_to: date });
        const { data: inst, error: instErr } = await supabase
          .from("meeting_instances")
          .select("id")
          .eq("meeting_type_id", type.id)
          .eq("meeting_date", date)
          .single();
        if (instErr) return json({ error: instErr.message }, 400);
        return json({ success: true, instance_id: inst.id });
      }

      // ---- Attendance + action-item statistics for a date range ----
      case "meeting_stats": {
        const today = taipeiToday();
        const from = body.from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const to = body.to || today;
        if (from > to) return json({ error: "日期區間不正確。" }, 400);
        if ((new Date(to).getTime() - new Date(from).getTime()) / 86400000 > MAX_RANGE_DAYS) {
          return json({ error: `區間最多 ${MAX_RANGE_DAYS} 天。` }, 400);
        }
        await supabase.rpc("ensure_meeting_instances", { p_from: from, p_to: to });
        const [types, instances, attendance, items] = await Promise.all([
          fetchAll(() => supabase.from("meeting_types").select("id, name").order("id", { ascending: true })),
          fetchAll(() => supabase.from("meeting_instances").select("id, meeting_date, status, meeting_type_id").gte("meeting_date", from).lte("meeting_date", to).order("id", { ascending: true })),
          fetchAll(() => supabase.from("meeting_attendance").select("id, meeting_instance_id, user_id, attended, users(display_name), meeting_instances!inner(meeting_date)").gte("meeting_instances.meeting_date", from).lte("meeting_instances.meeting_date", to).order("id", { ascending: true })),
          fetchAll(() => supabase.from("meeting_action_items").select("id, status, assignee_user_id, users(display_name), meeting_instances!inner(meeting_date)").gte("meeting_instances.meeting_date", from).lte("meeting_instances.meeting_date", to).order("id", { ascending: true })),
        ]);
        return json({ from, to, ...computeStats({ types, instances, attendance, items }, today) });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "伺服器發生錯誤，請稍後再試。Server error." }, 500);
  }
});
