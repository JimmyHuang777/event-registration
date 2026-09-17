// =========================================================
// SUPABASE EDGE FUNCTION: registrant-api
//
// This is the ONLY way registrants' data ever gets written.
// The browser sends LINE's ID token along with every request;
// this function verifies that token directly with LINE's servers
// before trusting anything about "who is making this request."
//
// v2: one verified LINE identity (the "submitter") can now register
// MULTIPLE attendees for the same event (e.g. a family, or a group
// leader registering coworkers) — each attendee is its own
// `registrations` row with its own attendee_name/attendee_phone,
// but all rows stay linked to the submitter's user_id, so ownership
// checks (edit/cancel your own submissions) still hold.
//
// DEPLOY:
//   supabase functions deploy registrant-api
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
// automatically by Supabase — you don't need to set those yourself.
// LINE_CHANNEL_ID must already be set (unchanged from before).
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

// Verifies the LINE ID token directly against LINE's own servers.
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

    // Look up (but don't yet trust-write) any existing profile for this verified identity
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("line_user_id", lineUserId)
      .maybeSingle();

    switch (action) {
      // ---- Get the submitter's own profile + ALL their registrations for one event ----
      case "get_my_data": {
        const { event_id } = body;
        let registrations: unknown[] = [];
        if (existingUser && event_id) {
          const { data } = await supabase
            .from("registrations")
            .select("*")
            .eq("user_id", existingUser.id)
            .eq("event_id", event_id)
            .neq("status", "cancelled")
            .order("created_at", { ascending: true });
          registrations = data || [];
        }
        return json({ user: existingUser || null, registrations });
      }

      // ---- Register one or more attendees for one event in a single call ----
      // Always INSERTS new rows — it does not touch any of the submitter's
      // existing registrations for this event. To change or remove an
      // existing attendee, use update_attendee / cancel_registration.
      case "register_for_event": {
        const { display_name, phone, email, event_id, attendees } = body;

        if (!event_id) return json({ error: "Missing event_id." }, 400);
        if (!Array.isArray(attendees) || attendees.length === 0) {
          return json({ error: "Missing attendees." }, 400);
        }
        for (const a of attendees) {
          if (!a || !a.name || !String(a.name).trim()) {
            return json({ error: "Every attendee needs a name." }, 400);
          }
        }

        // The submitter's own profile — identity + contact info,
        // independent from each attendee's own name/phone.
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .upsert(
            {
              line_user_id: lineUserId,
              display_name: display_name || claims.name || "LINE User",
              phone: phone || null,
              email: email || null,
              line_picture_url: claims.picture || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "line_user_id" }
          )
          .select()
          .single();

        if (userErr) return json({ error: userErr.message }, 400);

        const rowsToInsert = attendees.map((a: any) => ({
          user_id: userRow.id,
          event_id,
          attendee_name: String(a.name).trim(),
          attendee_phone: a.phone || null,
          notes: a.notes || null,
          extra_data: a.extra_data || {},
          status: "pending",
        }));

        const { data: regRows, error: regErr } = await supabase
          .from("registrations")
          .insert(rowsToInsert)
          .select();

        if (regErr) return json({ error: regErr.message }, 400);

        return json({ user: userRow, registrations: regRows });
      }

      // ---- Edit one attendee the submitter already registered ----
      case "update_attendee": {
        const { registration_id, name, phone, extra_data, notes } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!registration_id) return json({ error: "Missing registration_id." }, 400);

        // Ownership check: this row must belong to the verified submitter.
        const { data: existingReg } = await supabase
          .from("registrations")
          .select("id, user_id")
          .eq("id", registration_id)
          .maybeSingle();

        if (!existingReg || existingReg.user_id !== existingUser.id) {
          return json({ error: "You can only edit your own registrations." }, 403);
        }

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (name !== undefined) update.attendee_name = String(name).trim();
        if (phone !== undefined) update.attendee_phone = phone;
        if (extra_data !== undefined) update.extra_data = extra_data;
        if (notes !== undefined) update.notes = notes;

        const { data, error } = await supabase
          .from("registrations")
          .update(update)
          .eq("id", registration_id)
          .select()
          .single();

        if (error) return json({ error: error.message }, 400);
        return json({ registration: data });
      }

      // ---- Cancel ONE attendee's registration (soft: sets status, keeps history) ----
      case "cancel_registration": {
        const { registration_id } = body;
        if (!existingUser) return json({ error: "No profile found." }, 404);
        if (!registration_id) return json({ error: "Missing registration_id." }, 400);

        const { data: existingReg } = await supabase
          .from("registrations")
          .select("id, user_id")
          .eq("id", registration_id)
          .maybeSingle();

        if (!existingReg || existingReg.user_id !== existingUser.id) {
          return json({ error: "You can only cancel your own registrations." }, 403);
        }

        const { data, error } = await supabase
          .from("registrations")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", registration_id)
          .select()
          .single();

        if (error) return json({ error: error.message }, 400);
        return json({ registration: data });
      }

      // ---- Update just the submitter's own contact info (name/phone/email) ----
      case "update_profile": {
        const { display_name, phone, email } = body;
        if (!existingUser) return json({ error: "No profile found yet — register for an event first." }, 404);

        const { data, error } = await supabase
          .from("users")
          .update({
            display_name: display_name ?? existingUser.display_name,
            phone: phone ?? existingUser.phone,
            email: email ?? existingUser.email,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingUser.id)
          .select()
          .single();

        if (error) return json({ error: error.message }, 400);
        return json({ user: data });
      }

      // ---- Delete the submitter's profile entirely ----
      // Cascades to delete ALL attendees they ever registered too (see
      // schema: registrations.user_id references users(id) on delete cascade).
      case "delete_profile": {
        if (!existingUser) return json({ error: "No profile found." }, 404);

        const { error } = await supabase.from("users").delete().eq("id", existingUser.id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Server error. Please try again." }, 500);
  }
});
