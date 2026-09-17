// =========================================================
// SUPABASE EDGE FUNCTION: create-liff-app
//
// Called by the admin dashboard (Super Admin only). Creates a brand
// new LINE LIFF app via LINE's API and saves the resulting LIFF ID.
//
// Two modes:
//   1. Event mode  — { accessToken, event_id, slug, name }
//      Endpoint = LIFF_ENDPOINT_BASE_URL + "?event=" + slug
//      Saves the liffId onto that event's row (events.liff_id).
//   2. Generic mode — { accessToken, purpose, endpoint_path, name }
//      Endpoint = LIFF_ENDPOINT_BASE_URL + endpoint_path (e.g. "tasks.html")
//      Saves the liffId into liff_apps, keyed by "purpose" (e.g. "tasks").
//      Used for standalone pages that aren't tied to one event.
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { accessToken, event_id, slug, name, purpose, endpoint_path } = await req.json();
    if (!accessToken) return json({ error: "Missing accessToken." }, 400);

    const isEventMode = !!event_id;
    const isGenericMode = !!purpose;
    if (!isEventMode && !isGenericMode) {
      return json({ error: "Provide either event_id+slug (event mode) or purpose+endpoint_path (generic mode)." }, 400);
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

    const endpointUrl = isEventMode
      ? LIFF_ENDPOINT_BASE_URL.replace(/\/?$/, "/") + "?event=" + encodeURIComponent(slug)
      : LIFF_ENDPOINT_BASE_URL.replace(/\/?$/, "/") + endpoint_path.replace(/^\/+/, "");

    const channelAccessToken = await getLineChannelAccessToken();
    const liffId = await createLiffApp(channelAccessToken, endpointUrl, name || slug || purpose);

    if (isEventMode) {
      const { error: updateErr } = await supabase.from("events").update({ liff_id: liffId }).eq("id", event_id);
      if (updateErr) return json({ error: updateErr.message }, 400);
    } else {
      const { error: upsertErr } = await supabase
        .from("liff_apps")
        .upsert({ purpose, liff_id: liffId, updated_at: new Date().toISOString() }, { onConflict: "purpose" });
      if (upsertErr) return json({ error: upsertErr.message }, 400);
    }

    return json({ liffId, liffLink: "https://liff.line.me/" + liffId });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
