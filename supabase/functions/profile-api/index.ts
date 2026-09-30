// =========================================================
// SUPABASE EDGE FUNCTION: profile-api
//
// Backs profile.html (Home → 個人資訊 / 親友資訊) and the
// "帶入個人資訊 / 帶入親友資訊" buttons on the event registration page.
//
// Tables (see 40-personal-profile.sql):
//   user_profiles  — one row per member (their own info)
//   family_members — many rows per member (relatives / friends), same
//                    fields + `relationship` (與您的關係)
//
// Actions (all require a valid LINE ID token):
//   get_all         — { profile, family } for the caller
//   save_profile    — upsert the caller's own profile
//   save_family     — insert (no id) or update (id) one family member
//   delete_family   — delete one family member (caller's own only)
//
// DEPLOY: GitHub Actions workflow (--no-verify-jwt), like every other API.
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

const GENDERS = ["乾", "坤", "童", "女"];

// Validates + normalizes the shared personal fields.
function cleanPerson(body: any): { ok: true; value: Record<string, string | null> } | { ok: false; error: string } {
  const str = (v: unknown, max: number) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > max ? s.slice(0, max) : s;
  };
  const full_name = str(body.full_name, 60);
  if (!full_name) return { ok: false, error: "請填寫姓名。" };
  const gender = str(body.gender, 4);
  if (gender && !GENDERS.includes(gender)) return { ok: false, error: "性別必須是 乾／坤／童／女 其中之一。" };
  return {
    ok: true,
    value: {
      altar_name: str(body.altar_name, 60) || null,
      full_name,
      gender: gender || null,
      duty: str(body.duty, 60) || null,
      shrine: str(body.shrine, 60) || null,
      phone: str(body.phone, 30) || null,
    },
  };
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

    // Find or create the caller's users row (same as the other APIs).
    let { data: user } = await supabase.from("users").select("id").eq("line_user_id", claims.sub).maybeSingle();
    if (!user) {
      const { data: newUser, error: newUserErr } = await supabase
        .from("users")
        .upsert(
          {
            line_user_id: claims.sub,
            display_name: claims.name || "LINE User",
            line_picture_url: claims.picture || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "line_user_id" },
        )
        .select("id")
        .single();
      if (newUserErr) return json({ error: newUserErr.message }, 400);
      user = newUser;
    }
    const userId = user!.id as string;

    switch (action) {
      case "get_all": {
        const [{ data: profile }, { data: family }] = await Promise.all([
          supabase.from("user_profiles").select("*").eq("user_id", userId).maybeSingle(),
          supabase.from("family_members").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
        ]);
        return json({ profile: profile || null, family: family || [] });
      }

      case "save_profile": {
        const c = cleanPerson(body);
        if (!c.ok) return json({ error: c.error }, 400);
        const { data, error } = await supabase
          .from("user_profiles")
          .upsert({ user_id: userId, ...c.value, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ profile: data });
      }

      case "save_family": {
        const c = cleanPerson(body);
        if (!c.ok) return json({ error: c.error }, 400);
        const relationship = typeof body.relationship === "string" ? body.relationship.trim().slice(0, 30) : "";
        if (!relationship) return json({ error: "請填寫與您的關係。" }, 400);
        const row = { ...c.value, relationship, updated_at: new Date().toISOString() };

        if (body.id) {
          const { data, error } = await supabase
            .from("family_members")
            .update(row)
            .eq("id", body.id)
            .eq("user_id", userId)
            .select()
            .maybeSingle();
          if (error) return json({ error: error.message }, 400);
          if (!data) return json({ error: "找不到這筆親友資料。" }, 404);
          return json({ member: data });
        }
        const { data, error } = await supabase
          .from("family_members")
          .insert({ user_id: userId, ...row })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ member: data });
      }

      case "delete_family": {
        if (!body.id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("family_members").delete().eq("id", body.id).eq("user_id", userId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
