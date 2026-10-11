// =========================================================
// Shared LINE push helper (imported by dispatch-run, carpool-api,
// events-admin-api). Every push goes through pushLogged(), which:
//   1. checks the monthly message quota first (all-or-nothing: if the quota
//      cannot cover the recipients nothing is sent),
//   2. sends via the Messaging API multicast endpoint (500 per request),
//   3. writes ONE row to line_push_log with the outcome in plain Chinese,
//   4. refreshes line_quota_status, which the Dashboard shows as a warning.
// A notification problem NEVER throws: callers' own actions must not fail
// because LINE could not be reached.
// Env: LINE_CHANNEL_ACCESS_TOKEN
// =========================================================

// deno-lint-ignore no-explicit-any
type SB = any;

const LINE_API = "https://api.line.me/v2/bot";

export type PushStatus = "sent" | "partial" | "failed" | "quota_blocked" | "no_token" | "no_recipients" | "duplicate";
export interface PushResult { status: PushStatus; sent: number; recipients: number; message: string }

const token = () => Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
export const taipeiToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
/** ISO timestamp → "M/D HH:mm" in 台灣時間 */
export const fmtTaipei = (iso: string) => {
  const d = new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString();
  return `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)} ${d.slice(11, 16)}`;
};

export async function getHomeLink(sb: SB): Promise<string | null> {
  const { data } = await sb.from("liff_apps").select("liff_id").eq("purpose", "home").maybeSingle();
  return data?.liff_id ? `https://liff.line.me/${data.liff_id}` : null;
}

/** LINE ids of every member of the given groups (optionally minus some user ids). */
export async function groupMemberLineIds(sb: SB, groupIds: string[], excludeUserIds: Set<string> = new Set()): Promise<string[]> {
  if (!groupIds.length) return [];
  const { data: gm } = await sb.from("task_group_members").select("user_id").in("group_id", groupIds);
  const uids = [...new Set((gm || []).map((r: any) => r.user_id as string))].filter((u) => !excludeUserIds.has(u));
  if (!uids.length) return [];
  const out: string[] = [];
  for (let i = 0; i < uids.length; i += 200) {
    const { data: us } = await sb.from("users").select("line_user_id").in("id", uids.slice(i, i + 200));
    (us || []).forEach((u: any) => { if (u.line_user_id) out.push(u.line_user_id); });
  }
  return [...new Set(out)];
}

/** Monthly quota: { limit: number|null (null = unlimited), used, remaining } or null if LINE could not be asked. */
export async function lineQuota(): Promise<{ limit: number | null; used: number; remaining: number | null } | null> {
  const t = token();
  if (!t) return null;
  try {
    const h = { Authorization: `Bearer ${t}` };
    const [q, c] = await Promise.all([fetch(`${LINE_API}/message/quota`, { headers: h }), fetch(`${LINE_API}/message/quota/consumption`, { headers: h })]);
    if (!q.ok || !c.ok) return null;
    const quota = await q.json(), cons = await c.json();
    const used = Number(cons.totalUsage) || 0;
    if (quota.type === "limited") return { limit: Number(quota.value), used, remaining: Math.max(0, Number(quota.value) - used) };
    return { limit: null, used, remaining: null };
  } catch (_e) {
    return null;
  }
}

/**
 * Re-read the quota and store it. `problem` marks a failure to show on the Dashboard;
 * with no problem, an old warning is cleared once the quota is comfortable again
 * (e.g. new month, or a bigger plan).
 */
export async function refreshQuotaStatus(sb: SB, problem?: string): Promise<{ limit: number | null; used: number; remaining: number | null } | null> {
  const q = await lineQuota();
  const patch: Record<string, unknown> = { id: 1 };
  if (q) {
    patch.quota_limit = q.limit; patch.used = q.used; patch.remaining = q.remaining; patch.checked_at = new Date().toISOString();
    const low = q.remaining !== null && q.remaining <= Math.max(20, Math.ceil((q.limit || 0) * 0.1));
    if (!problem && !low) { patch.last_problem = null; patch.last_problem_at = null; }
  }
  if (problem) { patch.last_problem = problem; patch.last_problem_at = new Date().toISOString(); }
  await sb.from("line_quota_status").upsert(patch, { onConflict: "id" });
  return q;
}

async function multicast(ids: string[], text: string): Promise<{ sent: number; problems: string[]; quotaHit: boolean }> {
  const problems: string[] = [];
  let sent = 0, quotaHit = false;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500), n = Math.floor(i / 500) + 1;
    try {
      const r = await fetch(`${LINE_API}/message/multicast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ to: chunk, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
      });
      if (r.ok) { sent += chunk.length; continue; }
      let detail = "";
      try { const j = await r.json(); detail = j?.message ? String(j.message).slice(0, 120) : ""; } catch (_e) { /* no body */ }
      if (r.status === 429) quotaHit = true;
      const why = r.status === 429 ? "LINE 本月訊息額度已用完" : r.status === 401 ? "LINE token 無效或已過期" : r.status === 403 ? "LINE 拒絕（權限不足）" : r.status === 400 ? "LINE 回報要求不正確" : `LINE 回應 ${r.status}`;
      problems.push(`${why}${detail ? "（" + detail + "）" : ""}，第 ${n} 批 ${chunk.length} 人未送出`);
    } catch (e) {
      problems.push(`連線 LINE 失敗：${String(e).slice(0, 80)}，第 ${n} 批 ${chunk.length} 人未送出`);
    }
  }
  return { sent, problems, quotaHit };
}

/**
 * Send `text` to LINE user ids and log the outcome. Never throws.
 * dedupeKey: the same key is only ever sent once (a blocked/failed attempt releases
 * the key so a later run may retry; a successful or partial send keeps it).
 */
export async function pushLogged(sb: SB, o: { kind: string; ref?: string; title?: string; userIds: string[]; text: string; dedupeKey?: string }): Promise<PushResult> {
  const ids = [...new Set((o.userIds || []).filter(Boolean))];
  try {
    const { data: row, error: claimErr } = await sb.from("line_push_log").insert({
      kind: o.kind, ref: o.ref || null, title: o.title || null, recipients: ids.length, status: "claiming", dedupe_key: o.dedupeKey || null,
    }).select("id").single();
    if (claimErr) {
      if (String(claimErr.code) === "23505" || /duplicate/i.test(claimErr.message || "")) return { status: "duplicate", sent: 0, recipients: ids.length, message: "已推送過" };
      console.error("line_push_log insert failed", claimErr.message);
    }
    const finish = async (status: PushStatus, sent: number, message: string, release = false): Promise<PushResult> => {
      if (row?.id) await sb.from("line_push_log").update({ status, sent, message, ...(release ? { dedupe_key: null } : {}) }).eq("id", row.id);
      return { status, sent, recipients: ids.length, message };
    };

    if (!token()) {
      await refreshQuotaStatus(sb, "未設定 LINE_CHANNEL_ACCESS_TOKEN，所有 LINE 通知都無法送出");
      return await finish("no_token", 0, "未設定 LINE_CHANNEL_ACCESS_TOKEN，沒有推送", true);
    }
    if (!ids.length) return await finish("no_recipients", 0, "沒有可通知的對象（沒有成員，或成員沒有 LINE 帳號資料）");

    const q = await lineQuota();
    if (q && q.remaining !== null && q.remaining < ids.length) {
      const msg = `LINE 額度不足：本月剩 ${q.remaining} 則，這次需要 ${ids.length} 則，沒有推送`;
      await refreshQuotaStatus(sb, msg);
      return await finish("quota_blocked", 0, msg, true);
    }

    const r = await multicast(ids, o.text);
    const status: PushStatus = r.sent === ids.length ? "sent" : r.sent > 0 ? "partial" : "failed";
    const msg = r.problems.length ? r.problems.join("；") : `已送出 ${r.sent} 人`;
    await refreshQuotaStatus(sb, r.quotaHit ? "LINE 本月訊息額度已用完" : (r.problems.length ? r.problems[0] : undefined));
    return await finish(status, r.sent, msg, status === "failed");
  } catch (e) {
    console.error("pushLogged failed", e);
    return { status: "failed", sent: 0, recipients: ids.length, message: "推送發生錯誤：" + String(e).slice(0, 100) };
  }
}

/**
 * 報名表開始報名：推送給活動可見群組的成員（公開活動＝沒有群組，不推）。
 * 每個活動只推一次（dedupe）。Never throws.
 */
export async function notifyEventOpened(sb: SB, eventId: string): Promise<PushResult | { status: "skipped"; message: string }> {
  try {
    const { data: ev } = await sb.from("events").select("id, name, event_date, location, registration_deadline, is_active, notify_on_open").eq("id", eventId).maybeSingle();
    if (!ev) return { status: "skipped", message: "找不到活動" };
    if (!ev.is_active) return { status: "skipped", message: "活動未啟用" };
    if (!ev.notify_on_open) return { status: "skipped", message: "此活動未勾選開放報名通知" };
    if (ev.registration_deadline && Date.now() > Date.parse(ev.registration_deadline)) return { status: "skipped", message: "報名已截止" };
    const { data: eg } = await sb.from("event_groups").select("group_id").eq("event_id", eventId);
    const gids = (eg || []).map((r: any) => r.group_id as string);
    if (!gids.length) return { status: "skipped", message: "公開活動（未指定群組）不推送" };
    const [ids, link] = await Promise.all([groupMemberLineIds(sb, gids), getHomeLink(sb)]);
    const lines = [`📢 開放報名：${ev.name}`];
    if (ev.event_date) lines.push(`日期：${ev.event_date}${ev.location ? "　地點：" + ev.location : ""}`);
    if (ev.registration_deadline) lines.push(`報名截止：${fmtTaipei(ev.registration_deadline)}`);
    if (link) lines.push("", `請開啟：${link}`);
    return await pushLogged(sb, { kind: "event_open", ref: eventId, title: ev.name, userIds: ids, text: lines.join("\n"), dedupeKey: `event_open:${eventId}` });
  } catch (e) {
    console.error("notifyEventOpened failed", e);
    return { status: "skipped", message: "通知發生錯誤" };
  }
}
