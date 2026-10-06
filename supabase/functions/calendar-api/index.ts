// =========================================================
// SUPABASE EDGE FUNCTION: calendar-api
//
// Backs calendar.html — the member-facing 行事曆. One action:
//   month { year, month }  — everything dated inside that month:
//     - calendar_entries   (純行事曆行程，所有成員可見)
//     - events             (班程報名；active 且對該成員可見)
//     - jobs               (only when with_tasks=true; every recurrence, visible ones)
// Visibility for events / jobs is the same rule used by home-api:
// no group rows = public; otherwise group member, or altar-visible.
// Auth: LINE ID token. Deployed with --no-verify-jwt.
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
  return data.sub ? (data as { sub: string; name?: string; picture?: string }) : null;
}

async function visibleAltarIdSet(altarIds: string[], userId: string | null) {
  const out = new Set<string>();
  if (!userId) return out;
  for (const aid of new Set(altarIds)) {
    const { data, error } = await supabase.rpc("is_altar_visible_to_user", { p_altar_id: aid, p_user_id: userId });
    if (!error && data) out.add(aid);
  }
  return out;
}

// rows: [{ id, altar_id }], links: [{ id, group_id }] → ids this member may see
async function visibleIds(rows: any[], links: any[], myGroupIds: Set<string>, userId: string | null) {
  const groupsById: Record<string, string[]> = {};
  links.forEach((l) => { (groupsById[l.id] ||= []).push(l.group_id); });
  const altarOk = await visibleAltarIdSet(rows.map((r) => r.altar_id).filter(Boolean), userId);
  return new Set(
    rows
      .filter((r) => {
        if (r.altar_id && altarOk.has(r.altar_id)) return true;
        const g = groupsById[r.id];
        if (!g || g.length === 0) return true;
        return g.some((gid) => myGroupIds.has(gid));
      })
      .map((r) => r.id),
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const body = await req.json();
    if (!body.idToken) return json({ error: "Missing LINE ID token." }, 401);
    const claims = await verifyLineToken(body.idToken);
    if (!claims) return json({ error: "Your LINE session is invalid or expired. Please reopen this page from LINE." }, 401);

    if (body.action !== "month") return json({ error: "Unknown action." }, 400);

    const year = parseInt(String(body.year), 10);
    const month = parseInt(String(body.month), 10);
    if (!year || !month || month < 1 || month > 12) return json({ error: "Invalid month." }, 400);
    const pad = (n: number) => String(n).padStart(2, "0");
    const first = `${year}-${pad(month)}-01`;
    const last = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;

    const { data: user } = await supabase.from("users").select("id").eq("line_user_id", claims.sub).maybeSingle();
    const userId: string | null = user ? user.id : null;
    let myGroupIds = new Set<string>();
    if (userId) {
      const { data: gm } = await supabase.from("task_group_members").select("group_id").eq("user_id", userId);
      myGroupIds = new Set((gm || []).map((r: any) => r.group_id));
    }

    const items: any[] = [];

    // 1) plain calendar entries (overlapping the month)
    const { data: entries } = await supabase
      .from("calendar_entries")
      .select("id, entry_date, end_date, title, time_text, place, notes, category, lunar_text, kowtow")
      .lte("entry_date", last)
      .or(`end_date.gte.${first},and(end_date.is.null,entry_date.gte.${first})`)
      .order("entry_date", { ascending: true });
    (entries || []).forEach((e: any) =>
      items.push({ kind: e.category === "saint" ? "saint" : "entry", id: e.id, date: e.entry_date, end_date: e.end_date, title: e.title, time: e.time_text, place: e.place, notes: e.notes, lunar: e.lunar_text, kowtow: e.kowtow }));

    // 2) events dated in the month
    const { data: evs } = await supabase
      .from("events").select("id, name, slug, event_date, location, altar_id")
      .eq("is_active", true).gte("event_date", first).lte("event_date", last);
    if (evs && evs.length > 0) {
      const { data: links } = await supabase.from("event_groups").select("event_id, group_id").in("event_id", evs.map((e: any) => e.id));
      const ok = await visibleIds(evs, (links || []).map((l: any) => ({ id: l.event_id, group_id: l.group_id })), myGroupIds, userId);
      evs.filter((e: any) => ok.has(e.id)).forEach((e: any) =>
        items.push({ kind: "event", id: e.id, date: e.event_date, end_date: null, title: e.name, place: e.location, slug: e.slug }));
    }

    // 3) jobs (every recurrence) — only when the caller asks (with_tasks),
    //    since daily jobs add one entry per day.
    if (body.with_tasks) {
      await supabase.rpc("ensure_task_instances", { p_from: first, p_to: last });
      const { data: insts } = await supabase
        .from("task_instances")
        .select("occurrence_date, template_id, task_templates ( id, title, place, recurrence, is_active, altar_id )")
        .gte("occurrence_date", first).lte("occurrence_date", last)
        .order("occurrence_date", { ascending: true });
      const live = (insts || []).filter((i: any) => i.task_templates && i.task_templates.is_active);
      if (live.length > 0) {
        const tpls = Array.from(new Map(live.map((i: any) => [i.template_id, i.task_templates])).values());
        const { data: links } = await supabase.from("task_template_groups").select("template_id, group_id").in("template_id", tpls.map((t: any) => t.id));
        const ok = await visibleIds(tpls, (links || []).map((l: any) => ({ id: l.template_id, group_id: l.group_id })), myGroupIds, userId);
        live.filter((i: any) => ok.has(i.template_id)).forEach((i: any) =>
          items.push({ kind: "task", id: i.template_id, date: i.occurrence_date, end_date: null, title: i.task_templates.title, place: i.task_templates.place, once: i.task_templates.recurrence === "once" }));
      }
    }

    items.sort((a, b) => a.date.localeCompare(b.date));
    return json({ year, month, items });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
