// =========================================================
// SUPABASE EDGE FUNCTION: create-liff-app
//
// Called by the admin dashboard (Super Admin only). The whole system now
// runs on ONE LIFF app — "home" — whose endpoint is the SITE ROOT. LIFF
// lets liff.init() work on the endpoint URL and any page below it, so
// every page (home.html, tasks.html, index.html?event=..., altar-hub.html
// ...) shares that one app and Home links to them with plain relative
// links. Nothing per-event, per-altar or per-feature is ever created.
//
// Request: { accessToken, purpose, endpoint_path, name }
//   - endpoint_path "/" (or "") = site root.
//   - Saves into liff_apps keyed by purpose. Regenerating deletes the
//     previous app for that purpose first (LINE has no "update endpoint"
//     call) so a slot is never burned permanently.
//
// DEPLOY: GitHub Actions workflow deploys it automatically on push.
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

// Best-effort cleanup of the replaced app (LINE has no "update endpoint"
// call, only replace-by-recreate).
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const { accessToken, name, purpose, endpoint_path } = await req.json();
    if (!accessToken) return json({ error: "Missing accessToken." }, 400);
    if (!purpose) return json({ error: "Missing purpose." }, 400);

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

    const { data: existing } = await supabase.from("liff_apps").select("liff_id").eq("purpose", purpose).maybeSingle();
    const oldLiffId: string | null = existing?.liff_id ?? null;

    const endpointUrl = LIFF_ENDPOINT_BASE_URL.replace(/\/+$/, "/") + String(endpoint_path || "").replace(/^\/+/, "");

    const channelAccessToken = await getLineChannelAccessToken();

    // Create the new app first, delete the old one only afterwards, so a
    // failed create never leaves the system without a working link.
    const liffId = await createLiffApp(channelAccessToken, endpointUrl, name || purpose);

    const { error: upsertErr } = await supabase
      .from("liff_apps")
      .upsert({ purpose, liff_id: liffId, updated_at: new Date().toISOString() }, { onConflict: "purpose" });
    if (upsertErr) return json({ error: upsertErr.message }, 400);

    if (oldLiffId && oldLiffId !== liffId) {
      await deleteLiffApp(channelAccessToken, oldLiffId);
    }

    return json({ liffId, liffLink: "https://liff.line.me/" + liffId });
  } catch (err) {
    console.error(err);
    return json({ error: "伺服器發生錯誤，請稍後再試。Server error." }, 500);
  }
});
