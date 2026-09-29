// =========================================================
// SUPABASE EDGE FUNCTION: create-liff-app
//
// Called by the admin dashboard (Super Admin only). Creates or reuses
// LINE LIFF app(s) and saves the resulting LIFF ID(s).
//
// LINE caps every channel at 30 LIFF apps. Events and altars can grow
// without bound (Jimmy expects up to ~30 events alive at once on
// their own), so those two do NOT get a dedicated LIFF app per
// entity any more — that would blow the 30-app ceiling on its own.
// Instead:
//
//   1. Event mode  — { accessToken, event_id, slug, name }
//      Reuses ONE shared "events" LIFF app for every event (endpoint
//      = LIFF_ENDPOINT_BASE_URL, i.e. index.html), creating it only
//      the first time this ever runs. The specific event is carried
//      via a query param appended to the shareable liff.line.me link
//      itself — NOT baked into the registered endpoint — which LINE
//      forwards to the page as a `liff.state` param (see
//      index.html's getEventSlugFromUrl(), which decodes it). This
//      means unlimited concurrent events cost exactly ONE LIFF app,
//      total, forever.
//      Saves the shared liffId onto EVERY event's liff_id (they're
//      all the same id — only the query param in the link differs).
//
//   2. Generic mode — { accessToken, purpose, endpoint_path, name }
//      Unchanged: one dedicated LIFF app per purpose (e.g. "tasks"),
//      since there are only ~10 of these, fixed. Endpoint =
//      LIFF_ENDPOINT_BASE_URL + endpoint_path. Saves into liff_apps,
//      keyed by purpose. Recreating deletes the previous app for
//      that purpose first (see deleteLiffApp) so regenerating a
//      generic link never burns a slot permanently, and every new
//      link is cache-busted (see withCacheBust) so LINE can't keep
//      showing a stale cached title for it.
//
//   3. Altar mode — { accessToken, altar_id, name }
//      Same shared-app approach as event mode: ONE shared "altar
//      hub" LIFF app (endpoint = LIFF_ENDPOINT_BASE_URL +
//      "altar-hub.html") for every altar, with the specific altar_id
//      carried the same liff.state way (see altar-hub.html's
//      getAltarIdFromUrl()). Saves the shared liffId onto EVERY
//      altar's liff_id.
//
// DEPLOY: same as registrant-api / tasks-api — this repo's GitHub
// Actions workflow deploys it automatically on push.
// =========================================================

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID")!;
const LINE_CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LIFF_ENDPOINT_BASE_URL = Deno.env.get("LIFF_ENDPOINT_BASE_URL")!;

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

async function getLineChannelAccessToken() {
  const res = await fetch("https://api.line.me/v2/oauth/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: LINE_CHANNEL_ID,
      client_secret: LINE_CHANNEL_SECRET,
    }),
  });
  if (!res.ok) throw new Error("Failed to get LINE channel access token: " + (await res.text()));
  const data = await res.json();
  return data.access_token as string;
}

async function createLiffApp(channelAccessToken: string, endpointUrl: string, description: string) {
  const res = await fetch("https://api.line.me/liff/v1/apps", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + channelAccessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      view: { type: "full", url: endpointUrl },
      description: description.slice(0, 100),
      features: { ble: false },
      scope: ["profile", "openid"],
      botPrompt: "normal",
    }),
  });
  if (!res.ok) throw new Error("LINE LIFF API error: " + (await res.text()));
  const data = await res.json();
  return data.liffId as string;
}

// Best-effort cleanup: LINE only allows 30 LIFF apps per channel, and
// createLiffApp always makes a brand-new one (LINE has no "update
// endpoint" call, only replace-by-recreate). Used by generic mode
// only now — event/altar mode reuse one shared app instead of ever
// recreating per entity.
async function deleteLiffApp(channelAccessToken: string, liffId: string) {
  try {
    const res = await fetch("https://api.line.me/liff/v1/apps/" + encodeURIComponent(liffId), {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + channelAccessToken },
    });
    if (!res.ok) {
      console.error("Failed to delete old LIFF app " + liffId + ": " + (await res.text()));
    }
  } catch (err) {
    console.error("Error deleting old LIFF app " + liffId + ": " + String(err));
  }
}

// Gets the one shared LIFF app for "events" or "altar_hub", creating
// it the first time it's needed. Returns its liffId. Once created,
// every later call just reads it back from liff_apps — no LINE API
// call at all, so this is cheap and safe to call on every page load.
async function getOrCreateSharedLiffApp(
  sharedPurpose: "events_shared" | "altar_hub_shared",
  endpointPath: string,
  description: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from("liff_apps")
    .select("liff_id")
    .eq("purpose", sharedPurpose)
    .maybeSingle();
  if (existing?.liff_id) return existing.liff_id as string;

  // First time ever — create it. Cache-bust it too (see generic mode's
  // comment on withCacheBust) in case this exact base URL was ever
  // opened before under a different registration.
  const endpointUrl = LIFF_ENDPOINT_BASE_URL.replace(/\/?$/, "/") + endpointPath + "?v=" + Date.now();
  const channelAccessToken = await getLineChannelAccessToken();
  const liffId = await createLiffApp(channelAccessToken, endpointUrl, description);

  const { error: upsertErr } = await supabase
    .from("liff_apps")
    .upsert({ purpose: sharedPurpose, liff_id: liffId, updated_at: new Date().toISOString() }, { onConflict: "purpose" });
  if (upsertErr) throw new Error(upsertErr.message);

  return liffId;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { accessToken, event_id, slug, name, purpose, endpoint_path, altar_id } = await req.json();
    if (!accessToken) return json({ error: "Missing accessToken." }, 400);

    const isEventMode = !!event_id;
    const isGenericMode = !!purpose;
    const isAltarMode = !!altar_id;
    if (!isEventMode && !isGenericMode && !isAltarMode) {
      return json({ error: "Provide event_id+slug (event mode), purpose+endpoint_path (generic mode), or altar_id (altar mode)." }, 400);
    }
    if (isEventMode && !slug) return json({ error: "Missing slug." }, 400);
    if (isGenericMode && !endpoint_path) return json({ error: "Missing endpoint_path." }, 400);

    // Verify the caller is a real, currently-logged-in Supabase user —
    // never trust a role claim sent from the browser directly.
    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      return json({ error: "Not authenticated." }, 401);
    }

    const { data: roleRow } = await supabase
      .from("admin_roles")
      .select("id")
      .eq("admin_user_id", userData.user.id)
      .eq("role", "super_admin")
      .maybeSingle();

    if (!roleRow) {
      return json({ error: "Only Super Admins can create LIFF apps." }, 403);
    }

    // ---------------- Event mode: shared app ----------------
    if (isEventMode) {
      const sharedLiffId = await getOrCreateSharedLiffApp("events_shared", "", "活動報名 Event Registration");
      // Keep every event's liff_id in sync with the shared id — cheap,
      // and means any event created before the shared app existed
      // (shouldn't happen once this is deployed, but just in case)
      // gets fixed up too.
      const { error: updateErr } = await supabase.from("events").update({ liff_id: sharedLiffId }).eq("id", event_id);
      if (updateErr) return json({ error: updateErr.message }, 400);

      const liffLink = "https://liff.line.me/" + sharedLiffId + "?event=" + encodeURIComponent(slug);
      return json({ liffId: sharedLiffId, liffLink });
    }

    // ---------------- Altar mode: shared app ----------------
    if (isAltarMode) {
      const sharedLiffId = await getOrCreateSharedLiffApp("altar_hub_shared", "altar-hub.html", "壇務 Altar Hub");
      const { error: updateErr } = await supabase.from("altars").update({ liff_id: sharedLiffId }).eq("id", altar_id);
      if (updateErr) return json({ error: updateErr.message }, 400);

      const liffLink = "https://liff.line.me/" + sharedLiffId + "?altar=" + encodeURIComponent(altar_id);
      return json({ liffId: sharedLiffId, liffLink });
    }

    // ---------------- Generic mode: one app per purpose (unchanged) ----------------
    const { data: existingGeneric } = await supabase.from("liff_apps").select("liff_id").eq("purpose", purpose).maybeSingle();
    const oldLiffId: string | null = existingGeneric?.liff_id ?? null;

    // Cache-busting: LINE's in-app browser caches a page's title/preview
    // per URL, not per LIFF ID — so recreating a LIFF app with the SAME
    // endpoint URL (e.g. clicking 建立 again for "home.html") does NOT
    // clear a stale cached title on people's phones. Appending a unique
    // "v=<timestamp>" query param makes every (re)created link a URL
    // LINE has never cached before, so the fresh title always shows.
    const endpointUrl = LIFF_ENDPOINT_BASE_URL.replace(/\/?$/, "/") + endpoint_path.replace(/^\/+/, "") + "?v=" + Date.now();

    const channelAccessToken = await getLineChannelAccessToken();

    // Delete the old LIFF app first (frees its slot) — best-effort, never
    // blocks issuing the new link even if this fails.
    if (oldLiffId) {
      await deleteLiffApp(channelAccessToken, oldLiffId);
    }

    const liffId = await createLiffApp(channelAccessToken, endpointUrl, name || purpose);

    const { error: upsertErr } = await supabase
      .from("liff_apps")
      .upsert({ purpose, liff_id: liffId, updated_at: new Date().toISOString() }, { onConflict: "purpose" });
    if (upsertErr) return json({ error: upsertErr.message }, 400);

    return json({ liffId, liffLink: "https://liff.line.me/" + liffId });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
