// =========================================================
// SUPABASE EDGE FUNCTION: dispatch-run  (自動派工)
//
// Looks at dispatch_rules and, for every calendar item / 初一十五 that is
// now inside a rule's lead window, (1) copies the rule's template event into
// a new registration form, (2) creates one-off jobs from the rule's job
// presets for the chosen groups, (3) pushes a LINE message to the group
// members, and (4) records it in dispatch_log (rule_id + source_key unique,
// so a source is never dispatched twice).
//
// Callers (either one):
//   - Scheduler (GitHub Actions daily): header  x-cron-secret = DISPATCH_CRON_SECRET
//   - Dashboard (super admin):          body.accessToken (Supabase session)
// Actions: run { dry_run?: boolean, today?: 'YYYY-MM-DD' }
//   dry_run = true → returns what WOULD be dispatched, writes nothing.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISPATCH_CRON_SECRET,
//      LINE_CHANNEL_ACCESS_TOKEN (optional; push silently skipped if unset).
// Deployed with --no-verify-jwt.
// =========================================================

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("DISPATCH_CRON_SECRET") || "";
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const DAY_MS = 86400000;
const taipeiToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);

const LUNAR_FMT = (() => { try { return new Intl.DateTimeFormat("en-US-u-ca-chinese", { timeZone: "UTC", month: "numeric", day: "numeric" }); } catch (_e) { return null; } })();
const LUNAR_MONTH_NAME = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
// 國曆日期 → { day, label }（農曆日、例如「十月十五」）；瀏覽器端 calendar.html 用同一套算法
function lunarOf(date: string): { day: number; label: string } | null {
  if (!LUNAR_FMT) return null;
  const p: Record<string, string> = {};
  LUNAR_FMT.formatToParts(new Date(date + "T12:00:00Z")).forEach((x) => { p[x.type] = x.value; });
  const day = parseInt(p.day, 10), mo = parseInt(p.month, 10);
  if (!(mo >= 1 && mo <= 12) || !(day >= 1 && day <= 30)) return null;
  return { day, label: (/bis/.test(p.month) ? "閏" : "") + LUNAR_MONTH_NAME[mo - 1] + "月" + (day === 1 ? "初一" : day === 15 ? "十五" : String(day)) };
}

async function pushLine(lineUserIds: string[], text: string): Promise<number> {
  if (!LINE_CHANNEL_ACCESS_TOKEN || lineUserIds.length === 0) return 0;
  let sent = 0;
  for (let i = 0; i < lineUserIds.length; i += 500) {
    const chunk = lineUserIds.slice(i, i + 500);
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/multicast", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        body: JSON.stringify({ to: chunk, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
      });
      if (r.ok) sent += chunk.length;
    } catch (_e) { /* best-effort */ }
  }
  return sent;
}

// Constant-time string compare (avoid leaking the secret through timing).
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

type Hit = { rule: any; key: string; date: string; title: string; place: string | null; notes: string | null };

// Which sources has this rule reached (inside its lead window, today..date)?
function findHits(rules: any[], entries: any[], today: string): Hit[] {
  const hits: Hit[] = [];
  const within = (rule: any, date: string) => { const n = daysBetween(today, date); return n >= 0 && n <= rule.lead_days; };
  for (const rule of rules) {
    if (rule.kind === "calendar_keyword" || rule.kind === "saint_day" || rule.kind === "calendar_entry") {
      for (const e of entries) {
        if (!within(rule, e.entry_date)) continue;
        if (rule.kind === "calendar_entry" && e.id !== rule.calendar_entry_id) continue;
        if (rule.kind === "calendar_keyword" && !(e.category !== "saint" && rule.keyword && String(e.title).includes(rule.keyword))) continue;
        if (rule.kind === "saint_day" && !(e.category === "saint" && (!rule.keyword || String(e.title).includes(rule.keyword)))) continue;
        hits.push({ rule, key: `entry:${e.id}`, date: e.entry_date, title: e.title, place: e.place || null, notes: e.notes || null });
      }
    } else if (rule.kind === "lunar_day") {
      const wanted: number[] = rule.lunar_days || [];
      for (let n = 0; n <= rule.lead_days; n++) {
        const d = addDays(today, n), l = lunarOf(d);
        if (l && wanted.includes(l.day)) hits.push({ rule, key: `lunar:${d}`, date: d, title: l.label, place: null, notes: null });
      }
    }
  }
  return hits;
}

async function dispatchOne(hit: Hit, homeLink: string | null): Promise<{ event_id: string | null; template_ids: string[]; notified: number; summary: string }> {
  const { rule } = hit;
  const dateLabel = hit.date.slice(5).replace("-", "/");
  let eventId: string | null = null, slug: string | null = null;
  const lines: string[] = [];

  // 1) registration form = copy of the template event
  if (rule.template_event_id) {
    const { data: tpl } = await supabase.from("events").select("*").eq("id", rule.template_event_id).maybeSingle();
    if (tpl) {
      slug = `auto-${hit.date.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
      const desc = [tpl.description, hit.notes].filter(Boolean).join("\n\n") || null;
      // Deadline: keep the template's "N days before the event" offset (台灣時間 midnight of the event day).
      let deadline: string | null = null;
      if (tpl.registration_deadline && tpl.event_date) {
        const off = Date.parse(tpl.event_date + "T00:00:00+08:00") - Date.parse(tpl.registration_deadline);
        const dl = Date.parse(hit.date + "T00:00:00+08:00") - off;
        if (off >= 0 && dl > Date.now()) deadline = new Date(dl).toISOString();
      }
      const { data: ev, error } = await supabase.from("events").insert({
        name: hit.title, event_date: hit.date, location: hit.place || tpl.location || null, description: desc,
        slug, form_schema: tpl.form_schema, altar_id: tpl.altar_id || null, is_featured: false, is_active: true,
        offers_transport: !!tpl.offers_transport, offers_lodging: !!tpl.offers_lodging, registration_deadline: deadline,
      }).select("id").single();
      if (error) throw new Error("建立報名表失敗：" + error.message);
      eventId = ev.id;
      let gids: string[] = rule.event_group_ids || [];
      if (!gids.length) {
        const { data: tg } = await supabase.from("event_groups").select("group_id").eq("event_id", tpl.id);
        gids = (tg || []).map((r: any) => r.group_id);
      }
      if (gids.length) await supabase.from("event_groups").insert(gids.map((g) => ({ event_id: eventId, group_id: g })));
      lines.push(`📝 報名：${hit.title}`);
    }
  }

  // 2) jobs from presets
  const templateIds: string[] = [];
  const notifyGroups = new Set<string>([...(rule.event_group_ids || [])]);
  if ((rule.preset_ids || []).length) {
    const { data: presets } = await supabase.from("task_job_presets").select("*").in("id", rule.preset_ids);
    for (const p of presets || []) {
      const { data: t, error } = await supabase.from("task_templates").insert({
        title: p.title, description: p.description || null, recurrence: "once", recurrence_detail: {},
        slots_per_instance: 1, place: p.place || hit.place || null, start_date: hit.date, end_date: hit.date, is_active: true,
      }).select("id").single();
      if (error) throw new Error("建立工作失敗：" + error.message);
      templateIds.push(t.id);
      const subs = (Array.isArray(p.subtasks) ? p.subtasks : []).map((s: any, i: number) => ({
        template_id: t.id, title: s.title, section: s.section || null, slots: s.slots || 1, time_label: s.time_label || null,
        place: s.place || null, owner_note: s.owner_note || null, checker: s.checker || null, sort_order: i,
      }));
      if (subs.length) await supabase.from("task_subtask_templates").insert(subs);
      const gids: string[] = (rule.group_ids || []).length ? rule.group_ids : (p.group_ids || []);
      if (gids.length) await supabase.from("task_template_groups").insert(gids.map((g: string) => ({ template_id: t.id, group_id: g })));
      gids.forEach((g) => notifyGroups.add(g));
      lines.push(`🧹 工作：${p.title}`);
    }
  }
  (rule.group_ids || []).forEach((g: string) => notifyGroups.add(g));

  // 3) LINE push to the groups' members
  let notified = 0;
  if (rule.notify && notifyGroups.size) {
    const { data: gm } = await supabase.from("task_group_members").select("user_id").in("group_id", [...notifyGroups]);
    const uids = [...new Set((gm || []).map((r: any) => r.user_id))];
    if (uids.length) {
      const { data: us } = await supabase.from("users").select("line_user_id").in("id", uids);
      const ids = [...new Set((us || []).map((u: any) => u.line_user_id).filter(Boolean))] as string[];
      const text = `📣 ${hit.title}（${dateLabel}）\n${lines.join("\n")}${homeLink ? `\n\n請開啟：${homeLink}` : ""}`;
      notified = await pushLine(ids, text);
    }
  }
  return { event_id: eventId, template_ids: templateIds, notified, summary: lines.join("；") || "（無內容）" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const body = await req.json().catch(() => ({}));
    const cronOk = !!CRON_SECRET && safeEqual(req.headers.get("x-cron-secret") || "", CRON_SECRET);
    if (!cronOk) {
      if (!body.accessToken) return json({ error: "Missing accessToken." }, 401);
      const { data: u, error: ue } = await supabase.auth.getUser(body.accessToken);
      if (ue || !u?.user) return json({ error: "Not authenticated." }, 401);
      const { data: role } = await supabase.from("admin_roles").select("id").eq("admin_user_id", u.user.id).eq("role", "super_admin").maybeSingle();
      if (!role) return json({ error: "Only Super Admins can run dispatch." }, 403);
    }
    if (body.action && body.action !== "run") return json({ error: "Unknown action." }, 400);

    const dry = !!body.dry_run;
    const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today : taipeiToday();
    const { data: rules } = await supabase.from("dispatch_rules").select("*").eq("is_active", true);
    if (!rules || !rules.length) return json({ today, dry_run: dry, dispatched: [], skipped: 0 });

    const maxLead = Math.max(...rules.map((r: any) => r.lead_days));
    const { data: entries } = await supabase.from("calendar_entries")
      .select("id, entry_date, title, place, notes, category")
      .gte("entry_date", today).lte("entry_date", addDays(today, maxLead)).order("entry_date");

    const hits = findHits(rules, entries || [], today);
    const { data: logs } = hits.length
      ? await supabase.from("dispatch_log").select("rule_id, source_key").in("rule_id", [...new Set(hits.map((h) => h.rule.id))])
      : { data: [] as any[] };
    const done = new Set((logs || []).map((l: any) => `${l.rule_id}|${l.source_key}`));
    const fresh = hits.filter((h) => !done.has(`${h.rule.id}|${h.key}`));

    let homeLink: string | null = null;
    if (!dry && fresh.length) {
      const { data: home } = await supabase.from("liff_apps").select("liff_id").eq("purpose", "home").maybeSingle();
      if (home?.liff_id) homeLink = `https://liff.line.me/${home.liff_id}`;
    }

    const dispatched: any[] = [];
    for (const h of fresh) {
      const base = { rule_id: h.rule.id, rule_name: h.rule.name, source_key: h.key, date: h.date, title: h.title,
        presets: (h.rule.preset_ids || []).length, makes_event: !!h.rule.template_event_id };
      if (dry) { dispatched.push(base); continue; }
      // Claim first (unique key) so overlapping runs cannot dispatch twice.
      const { data: claim, error: ce } = await supabase.from("dispatch_log")
        .insert({ rule_id: h.rule.id, source_key: h.key, source_date: h.date, source_title: h.title, status: "running" })
        .select("id").single();
      if (ce) continue;
      try {
        const r = await dispatchOne(h, homeLink);
        await supabase.from("dispatch_log").update({ event_id: r.event_id, template_ids: r.template_ids, notified_count: r.notified, status: "ok", message: r.summary }).eq("id", claim.id);
        dispatched.push({ ...base, ...r });
      } catch (err) {
        await supabase.from("dispatch_log").update({ status: "error", message: String(err) }).eq("id", claim.id);
        dispatched.push({ ...base, error: String(err) });
      }
    }
    return json({ today, dry_run: dry, dispatched, skipped: hits.length - fresh.length });
  } catch (err) {
    console.error(err);
    return json({ error: "伺服器發生錯誤，請稍後再試。Server error." }, 500);
  }
});
