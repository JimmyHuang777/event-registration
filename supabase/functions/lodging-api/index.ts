// =========================================================
// SUPABASE EDGE FUNCTION: lodging-api
//
// Backs lodging.html — a standalone LIFF entry point (separate from
// the event registration page and from carpool.html) with three
// roles, built on exactly the same framework as carpool-api:
//   - Host    (房東) — registers a persistent property profile
//                 (property name/type/address, set once and reused
//                 for every event), then offers rooms (date/check-in
//                 time/check-out time/capacity) for one event at a
//                 time. Marks the offer "occupied" once a guest has
//                 actually checked in.
//   - Guest   (房客) — requests lodging for one event; sees their
//                 request's status and, once matched, the host's info.
//   - Lodging Manager (住宿管理員) — sees every offer + every
//                 pending/assigned request for one event and
//                 assigns/unassigns them. This is a brand-new,
//                 separate permission list (lodging_manager_admins)
//                 — independent of Event Admins AND of Car Managers.
//
// Actions (member — any registered LINE user):
//   whoami                 — registers/looks up the caller's `users`
//                             row, reports is_lodging_manager + their
//                             host_profile (if any).
//   list_active_events     — active events visible to this member
//                             that offer lodging (offers_lodging =
//                             true), for the event picker.
//   save_host_profile      — create/update the caller's persistent
//                             property profile.
//   list_my_offers         — the caller's own lodging offers for one
//                             event, each with its assigned guests
//                             and offer_status.
//   create_offer           — offer lodging for one event (requires a
//                             host_profile to already exist).
//   delete_offer           — delete an offer the caller posted (frees
//                             any assigned guests back to pending).
//   update_offer_status    — host marks an offer "occupied" once a
//                             guest has actually checked in.
//   get_my_lodging_request — the caller's own active lodging request
//                             for one event, with the assigned
//                             offer/host info if matched.
//   create_lodging_request — request lodging for one event.
//   cancel_lodging_request — cancel the caller's own lodging request.
//   complete_lodging_request — guest confirms check-out ("感謝天恩
//                             師德") once the offer is "occupied",
//                             closing this one-time stay and (once
//                             every guest on the offer has done the
//                             same) freeing the host back to
//                             available, with no Lodging Manager step
//                             required.
//
// Actions (Lodging Manager only — gated by lodging_manager_admins):
//   list_offers_for_event    — every offer for one event, with full
//                              guest lists (unlike list_my_offers,
//                              which only shows the caller's own).
//   list_requests_for_event  — every pending/assigned request for one
//                              event.
//   assign_lodging_request   — match a pending request to an offer
//                              with free capacity.
//   unassign_lodging_request — move an assigned request back to
//                              pending.
//   mark_offer_available     — manual override: free an occupied
//                              offer back to available.
//   manager_delete_offer     — admin override delete of any offer.
//   manager_delete_lodging_request — admin override delete of any
//                              request.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/lodging-api/**.
// Deployed with --no-verify-jwt (this function does its own auth via
// the LINE ID token, so Supabase's gateway-level JWT check must stay
// off — see the workflow file).
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

// Offer status has just one host-controlled step (unlike carpool's
// multi-stage drive): available -> occupied, once a guest actually
// checks in. Going back to available happens either automatically
// (every assigned guest has confirmed check-out) or via the Lodging
// Manager's manual override (mark_offer_available).
const HOST_STATUS_ORDER = ["available", "occupied"];

const MANAGER_ACTIONS = new Set([
  "list_offers_for_event",
  "list_requests_for_event",
  "assign_lodging_request",
  "unassign_lodging_request",
  "mark_offer_available",
  "manager_delete_offer",
  "manager_delete_lodging_request",
]);

// How many guests one lodging_request actually represents — the
// primary guest plus everyone in additional_guests.
function requestGuestCount(req: { additional_guests?: unknown }) {
  const extra = Array.isArray(req.additional_guests) ? req.additional_guests.length : 0;
  return 1 + extra;
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

    // Always register/refresh the caller's `users` row — same as
    // home-api's whoami — so this works even for a first-time visitor
    // who has never registered for an event.
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
      .from("lodging_manager_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isManager = !!managerRow;

    if (MANAGER_ACTIONS.has(action) && !isManager) {
      return json({ error: "您沒有住宿管理員的權限，請聯繫管理員。You don't have Lodging Manager permission." }, 403);
    }

    switch (action) {
      case "whoami": {
        const { data: profile } = await supabase
          .from("host_profiles")
          .select("contact_name, contact_phone, property_name, property_type, property_address")
          .eq("user_id", existingUser.id)
          .maybeSingle();
        return json({ user: existingUser, is_lodging_manager: isManager, host_profile: profile || null });
      }

      // ---- Active events visible to this member (same group-
      // visibility rule as home-api's event list) that offer lodging
      case "list_active_events": {
        const { data: myGroupRows } = await supabase
          .from("task_group_members")
          .select("group_id")
          .eq("user_id", existingUser.id);
        const myGroupIds = new Set((myGroupRows || []).map((r: any) => r.group_id));

        const { data: eventRows } = await supabase
          .from("events")
          .select("id, name, event_date, location")
          .eq("is_active", true)
          .eq("offers_lodging", true)
          .order("event_date", { ascending: true });
        const eventIds = (eventRows || []).map((e: any) => e.id);

        let groupsByEvent: Record<string, string[]> = {};
        if (eventIds.length > 0) {
          const { data: links } = await supabase.from("event_groups").select("event_id, group_id").in("event_id", eventIds);
          (links || []).forEach((r: any) => {
            (groupsByEvent[r.event_id] ||= []).push(r.group_id);
          });
        }

        const events = (eventRows || []).filter((e: any) => {
          const groups = groupsByEvent[e.id];
          if (!groups || groups.length === 0) return true; // public event
          return groups.some((gid) => myGroupIds.has(gid));
        });

        return json({ events });
      }

      // ---- Create/update the caller's persistent host profile:
      // their own contact info PLUS property info, kept separate from
      // the shared `users` row (same reason registrations keeps its
      // own attendee_name/attendee_phone) ----
      case "save_host_profile": {
        const contactName = (body.contact_name || "").trim();
        const contactPhone = (body.contact_phone || "").trim();
        const propertyName = (body.property_name || "").trim();
        const propertyType = (body.property_type || "").trim();
        const propertyAddress = (body.property_address || "").trim();
        if (!contactName || !contactPhone) return json({ error: "請填寫房東姓名與聯絡電話。" }, 400);
        if (!propertyName || !propertyAddress) return json({ error: "請填寫房源名稱與地址。" }, 400);

        const { data, error } = await supabase
          .from("host_profiles")
          .upsert(
            {
              user_id: existingUser.id,
              contact_name: contactName,
              contact_phone: contactPhone,
              property_name: propertyName,
              property_type: propertyType || null,
              property_address: propertyAddress,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ host_profile: data });
      }

      // ---- The caller's own lodging offers for one event, with
      // assigned guests ----
      case "list_my_offers": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: offers, error } = await supabase
          .from("lodging_offers")
          .select("id, available_date, check_in_time, check_out_time, capacity_total, notes, offer_status, created_at")
          .eq("event_id", event_id)
          .eq("host_user_id", existingUser.id)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const offerIds = (offers || []).map((o: any) => o.id);
        let guestsByOffer: Record<string, any[]> = {};
        if (offerIds.length > 0) {
          const { data: assigned } = await supabase
            .from("lodging_requests")
            .select("id, offer_id, guest_name, guest_phone, additional_guests, notes")
            .in("offer_id", offerIds)
            .eq("status", "assigned");
          (assigned || []).forEach((r: any) => {
            (guestsByOffer[r.offer_id] ||= []).push({
              name: r.guest_name || "—",
              phone: r.guest_phone || "",
              additional_guests: r.additional_guests || [],
              guest_count: requestGuestCount(r),
              notes: r.notes,
            });
          });
        }

        const offersOut = (offers || []).map((o: any) => ({ ...o, guests: guestsByOffer[o.id] || [] }));
        return json({ offers: offersOut });
      }

      // ---- Offer lodging for one event ----
      case "create_offer": {
        const { data: profile } = await supabase
          .from("host_profiles")
          .select("user_id")
          .eq("user_id", existingUser.id)
          .maybeSingle();
        if (!profile) return json({ error: "請先登記房源資訊，才能提供住宿。" }, 400);

        const { event_id, available_date, check_in_time, check_out_time, capacity_total, notes } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);
        const capacity = parseInt(capacity_total, 10);
        if (!capacity || capacity < 1) return json({ error: "請填寫有效的可住人數。" }, 400);
        if (check_in_time && check_out_time && String(check_out_time) <= String(check_in_time)) {
          return json({ error: "退房時間必須晚於入住時間。" }, 400);
        }

        const { data, error } = await supabase
          .from("lodging_offers")
          .insert({
            event_id,
            host_user_id: existingUser.id,
            available_date: (available_date || "").trim() || null,
            check_in_time: (check_in_time || "").trim() || null,
            check_out_time: (check_out_time || "").trim() || null,
            capacity_total: capacity,
            notes: (notes || "").trim() || null,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ offer: data });
      }

      // ---- Delete an offer the caller themselves posted ----
      case "delete_offer": {
        const { offer_id } = body;
        if (!offer_id) return json({ error: "Missing offer_id." }, 400);

        const { data: offer } = await supabase.from("lodging_offers").select("id, host_user_id").eq("id", offer_id).maybeSingle();
        if (!offer || offer.host_user_id !== existingUser.id) {
          return json({ error: "您只能刪除自己提供的住宿。" }, 403);
        }

        await supabase
          .from("lodging_requests")
          .update({ status: "pending", offer_id: null, updated_at: new Date().toISOString() })
          .eq("offer_id", offer_id);

        const { error } = await supabase.from("lodging_offers").delete().eq("id", offer_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Host marks their offer "occupied" once a guest has
      // actually checked in ----
      case "update_offer_status": {
        const { offer_id, next_status } = body;
        if (!offer_id || !next_status) return json({ error: "Missing offer_id or next_status." }, 400);

        const { data: offer } = await supabase.from("lodging_offers").select("id, host_user_id, offer_status").eq("id", offer_id).maybeSingle();
        if (!offer || offer.host_user_id !== existingUser.id) {
          return json({ error: "您只能更新自己提供的住宿狀態。" }, 403);
        }

        const currentIdx = HOST_STATUS_ORDER.indexOf(offer.offer_status);
        const nextIdx = HOST_STATUS_ORDER.indexOf(next_status);
        if (currentIdx === -1 || nextIdx !== currentIdx + 1) {
          return json({ error: "狀態只能依序推進，請重新整理頁面。" }, 400);
        }

        const { data, error } = await supabase
          .from("lodging_offers")
          .update({ offer_status: next_status })
          .eq("id", offer_id)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ offer: data });
      }

      // ---- The caller's own active lodging request for one event ----
      case "get_my_lodging_request": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: reqRow } = await supabase
          .from("lodging_requests")
          .select(
            "id, status, additional_guests, notes, offer_id, lodging_offers ( host_user_id, available_date, check_in_time, check_out_time, offer_status )"
          )
          .eq("event_id", event_id)
          .eq("user_id", existingUser.id)
          .in("status", ["pending", "assigned"])
          .maybeSingle();

        if (!reqRow) return json({ request: null });

        const offer = reqRow.lodging_offers as any;
        let hostProfile: any = null;
        if (offer) {
          const { data: profile } = await supabase
            .from("host_profiles")
            .select("contact_name, contact_phone, property_name, property_type, property_address")
            .eq("user_id", offer.host_user_id)
            .maybeSingle();
          hostProfile = profile;
        }

        return json({
          request: {
            id: reqRow.id,
            status: reqRow.status,
            additional_guests: reqRow.additional_guests || [],
            notes: reqRow.notes,
            offer: offer
              ? {
                  available_date: offer.available_date,
                  check_in_time: offer.check_in_time,
                  check_out_time: offer.check_out_time,
                  offer_status: offer.offer_status,
                  host_name: hostProfile?.contact_name || "—",
                  host_phone: hostProfile?.contact_phone || "",
                  property_name: hostProfile?.property_name || "",
                  property_type: hostProfile?.property_type || "",
                  property_address: hostProfile?.property_address || "",
                }
              : null,
          },
        });
      }

      // ---- Request lodging for one event ----
      case "create_lodging_request": {
        const { event_id, guest_name, guest_phone, notes } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const guestName = (guest_name || "").trim();
        const guestPhone = (guest_phone || "").trim();
        if (!guestName || !guestPhone) return json({ error: "請填寫姓名與聯絡電話。" }, 400);

        const additionalGuests = Array.isArray(body.additional_guests)
          ? body.additional_guests.map((n: unknown) => String(n || "").trim()).filter((n: string) => n.length > 0)
          : [];

        const { data, error } = await supabase
          .from("lodging_requests")
          .insert({
            event_id,
            user_id: existingUser.id,
            guest_name: guestName,
            guest_phone: guestPhone,
            additional_guests: additionalGuests,
            notes: (notes || "").trim() || null,
          })
          .select()
          .single();

        if (error) {
          if (error.message.includes("duplicate")) {
            return json({ error: "您已經送出過住宿需求，如需修改請先取消，再重新送出。" }, 400);
          }
          return json({ error: error.message }, 400);
        }
        return json({ request: data });
      }

      // ---- Cancel the caller's own lodging request ----
      case "cancel_lodging_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);

        const { data: reqRow } = await supabase.from("lodging_requests").select("id, user_id").eq("id", request_id).maybeSingle();
        if (!reqRow || reqRow.user_id !== existingUser.id) {
          return json({ error: "您只能取消自己的住宿需求。" }, 403);
        }

        const { error } = await supabase
          .from("lodging_requests")
          .update({ status: "cancelled", offer_id: null, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Guest confirms check-out ("感謝天恩師德"), closing this
      // one-time stay. Only allowed once the host has marked the
      // offer "occupied" (i.e. check-in has actually happened). Marks
      // the request completed and, once no other guest on the same
      // offer is still assigned, frees the host by setting the offer
      // back to available — no Lodging Manager involvement needed
      // for this normal completion path.
      case "complete_lodging_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);

        const { data: reqRow } = await supabase
          .from("lodging_requests")
          .select("id, user_id, status, offer_id")
          .eq("id", request_id)
          .maybeSingle();
        if (!reqRow || reqRow.user_id !== existingUser.id) {
          return json({ error: "您只能確認自己的住宿需求。" }, 403);
        }
        if (reqRow.status !== "assigned" || !reqRow.offer_id) {
          return json({ error: "此住宿尚未配對房東。" }, 400);
        }

        const { data: offer } = await supabase
          .from("lodging_offers")
          .select("id, offer_status")
          .eq("id", reqRow.offer_id)
          .maybeSingle();
        if (!offer || offer.offer_status !== "occupied") {
          return json({ error: "房東尚未標記「已入住」，請稍候再確認。" }, 400);
        }

        const { data, error } = await supabase
          .from("lodging_requests")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", request_id)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);

        // If no other guest on this offer is still assigned, the host
        // is free again — set the offer back to available.
        const { count } = await supabase
          .from("lodging_requests")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", reqRow.offer_id)
          .eq("status", "assigned");
        if (!count) {
          await supabase.from("lodging_offers").update({ offer_status: "available" }).eq("id", reqRow.offer_id);
        }

        return json({ request: data });
      }

      // =========================================================
      // LODGING MANAGER ACTIONS — gated by lodging_manager_admins.
      // =========================================================

      case "list_offers_for_event": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: offers, error } = await supabase
          .from("lodging_offers")
          .select("id, host_user_id, available_date, check_in_time, check_out_time, capacity_total, notes, offer_status, created_at")
          .eq("event_id", event_id)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const offerIds = (offers || []).map((o: any) => o.id);
        const hostIds = (offers || []).map((o: any) => o.host_user_id);

        let guestsByOffer: Record<string, any[]> = {};
        if (offerIds.length > 0) {
          const { data: assigned } = await supabase
            .from("lodging_requests")
            .select("id, offer_id, guest_name, guest_phone, additional_guests, notes")
            .in("offer_id", offerIds)
            .eq("status", "assigned");
          (assigned || []).forEach((r: any) => {
            (guestsByOffer[r.offer_id] ||= []).push({
              request_id: r.id,
              name: r.guest_name || "—",
              phone: r.guest_phone || "",
              additional_guests: r.additional_guests || [],
              guest_count: requestGuestCount(r),
              notes: r.notes,
            });
          });
        }

        let profileByHost: Record<string, any> = {};
        if (hostIds.length > 0) {
          const { data: profiles } = await supabase
            .from("host_profiles")
            .select("user_id, contact_name, contact_phone, property_name, property_type, property_address")
            .in("user_id", hostIds);
          (profiles || []).forEach((p: any) => { profileByHost[p.user_id] = p; });
        }

        const offersOut = (offers || []).map((o: any) => {
          const profile = profileByHost[o.host_user_id];
          return {
            id: o.id,
            host_name: profile?.contact_name || "—",
            host_phone: profile?.contact_phone || "",
            property_name: profile?.property_name || "",
            property_type: profile?.property_type || "",
            property_address: profile?.property_address || "",
            available_date: o.available_date,
            check_in_time: o.check_in_time,
            check_out_time: o.check_out_time,
            capacity_total: o.capacity_total,
            notes: o.notes,
            offer_status: o.offer_status,
            guests: guestsByOffer[o.id] || [],
          };
        });
        return json({ offers: offersOut });
      }

      case "list_requests_for_event": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data, error } = await supabase
          .from("lodging_requests")
          .select("id, status, guest_name, guest_phone, additional_guests, notes, offer_id, created_at")
          .eq("event_id", event_id)
          .neq("status", "cancelled")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const requests = (data || []).map((r: any) => ({
          id: r.id,
          status: r.status,
          additional_guests: r.additional_guests || [],
          guest_count: requestGuestCount(r),
          notes: r.notes,
          offer_id: r.offer_id,
          name: r.guest_name || "—",
          phone: r.guest_phone || "",
        }));
        return json({ requests });
      }

      case "assign_lodging_request": {
        const { request_id, offer_id } = body;
        if (!request_id || !offer_id) return json({ error: "Missing request_id or offer_id." }, 400);

        const { data: offer } = await supabase.from("lodging_offers").select("id, capacity_total").eq("id", offer_id).maybeSingle();
        if (!offer) return json({ error: "找不到此住宿房源。" }, 404);

        const { data: requestRow } = await supabase
          .from("lodging_requests")
          .select("id, additional_guests")
          .eq("id", request_id)
          .maybeSingle();
        if (!requestRow) return json({ error: "找不到此住宿申請。" }, 404);
        const requestGuests = requestGuestCount(requestRow);

        const { data: assignedRows } = await supabase
          .from("lodging_requests")
          .select("additional_guests")
          .eq("offer_id", offer_id)
          .eq("status", "assigned");
        const usedCapacity = (assignedRows || []).reduce((sum: number, r: any) => sum + requestGuestCount(r), 0);

        if (usedCapacity + requestGuests > offer.capacity_total) {
          return json({ error: "此房源可住人數不足，請選擇其他房源或增加可住人數。" }, 400);
        }

        const { error } = await supabase
          .from("lodging_requests")
          .update({ status: "assigned", offer_id, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "unassign_lodging_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);
        const { error } = await supabase
          .from("lodging_requests")
          .update({ status: "pending", offer_id: null, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Manager frees an occupied offer back to available
      // (manual override — the normal path is every assigned guest
      // confirming check-out via complete_lodging_request) ----
      case "mark_offer_available": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);

        const { data: offer } = await supabase.from("lodging_offers").select("id, offer_status").eq("id", id).maybeSingle();
        if (!offer) return json({ error: "找不到此住宿房源。" }, 404);
        if (offer.offer_status !== "occupied") {
          return json({ error: "只有已入住的房源，才能標記為可入住。" }, 400);
        }

        const { data, error } = await supabase.from("lodging_offers").update({ offer_status: "available" }).eq("id", id).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ offer: data });
      }

      case "manager_delete_offer": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        await supabase
          .from("lodging_requests")
          .update({ status: "pending", offer_id: null, updated_at: new Date().toISOString() })
          .eq("offer_id", id);
        const { error } = await supabase.from("lodging_offers").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "manager_delete_lodging_request": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("lodging_requests").delete().eq("id", id);
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
