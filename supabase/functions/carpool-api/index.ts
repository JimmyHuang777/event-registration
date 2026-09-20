// =========================================================
// SUPABASE EDGE FUNCTION: carpool-api
//
// Backs carpool.html — a standalone LIFF entry point (separate from
// the event registration page) with three roles:
//   - Driver    — registers a persistent car profile (brand/color/
//                 plate, set once and reused for every event), then
//                 offers a trip (date/time/pickup point/seats) for
//                 one event at a time. Advances that trip's status
//                 (not_started -> heading_to_pickup -> arrived ->
//                 delivered) as they actually make the run.
//   - Passenger — requests a ride for one event; sees their request's
//                 status and, once matched, the driver's info.
//   - Car Manager — sees every trip + every pending/assigned request
//                 for one event and assigns/unassigns them. This is
//                 a brand-new, separate permission list
//                 (car_manager_admins) — being an Event Admin does
//                 NOT make someone a Car Manager, and vice versa.
//
// Actions (member — any registered LINE user):
//   whoami               — registers/looks up the caller's `users`
//                           row, reports is_car_manager + their
//                           driver_profile (if any).
//   list_active_events   — active events visible to this member
//                           (same "no rows = public" group-visibility
//                           rule as home-api), for the event picker.
//   save_driver_profile  — create/update the caller's persistent car
//                           profile.
//   list_my_trips        — the caller's own trips for one event, each
//                           with its assigned passengers (name/phone/
//                           pickup/notes) and trip_status.
//   create_trip          — offer a ride for one event (requires a
//                           driver_profile to already exist).
//   delete_trip          — delete a trip the caller posted (frees any
//                           assigned passengers back to pending).
//   update_trip_status   — advance a trip the caller owns one step:
//                           not_started -> heading_to_pickup ->
//                           arrived -> delivered.
//   update_trip_location — driver updates where their car is
//                           currently waiting ("等待派送點"),
//                           independent of trip status, so the Car
//                           Manager always sees an up-to-date
//                           location to assign rides efficiently.
//   get_my_ride_request  — the caller's own active ride request for
//                           one event, with the assigned trip/driver
//                           info if matched.
//   create_ride_request  — request a ride for one event.
//   cancel_ride_request  — cancel the caller's own ride request.
//   complete_ride_request — passenger confirms drop-off ("感謝天恩
//                           師德") once the trip is "已抵達目的地",
//                           closing this one-time ride and (once
//                           every passenger on the trip has done the
//                           same) freeing the driver back to idle,
//                           with no Car Manager step required.
//
// Actions (Car Manager only — gated by car_manager_admins):
//   list_trips_for_event    — every trip for one event, with full
//                              passenger lists (unlike list_my_trips,
//                              which only shows the caller's own).
//   list_requests_for_event — every pending/assigned request for one
//                              event.
//   assign_ride_request     — match a pending request to a trip with
//                              a free seat.
//   unassign_ride_request   — move an assigned request back to
//                              pending.
//   manager_delete_trip     — admin override delete of any trip.
//   manager_delete_ride_request — admin override delete of any
//                              request.
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/carpool-api/**.
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

// Trip status progresses one step at a time. The driver clicks
// through the first five stages themselves, never skipping or going
// back; the final step (arrived_destination -> idle, marking the
// driver free again) is a Car Manager action instead, done via
// mark_trip_idle below.
const DRIVER_STATUS_ORDER = [
  "not_started", "heading_to_pickup", "arrived_pickup", "heading_to_destination", "arrived_destination",
];

const MANAGER_ACTIONS = new Set([
  "list_trips_for_event",
  "list_requests_for_event",
  "assign_ride_request",
  "unassign_ride_request",
  "mark_trip_idle",
  "manager_delete_trip",
  "manager_delete_ride_request",
]);

// How many passengers one ride_request actually represents — the
// primary passenger plus everyone in additional_passengers.
function requestPassengerCount(req: { additional_passengers?: unknown }) {
  const extra = Array.isArray(req.additional_passengers) ? req.additional_passengers.length : 0;
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
      .from("car_manager_admins")
      .select("user_id")
      .eq("user_id", existingUser.id)
      .maybeSingle();
    const isManager = !!managerRow;

    if (MANAGER_ACTIONS.has(action) && !isManager) {
      return json({ error: "您沒有共乘管理員的權限，請聯繫管理員。You don't have Car Manager permission." }, 403);
    }

    switch (action) {
      case "whoami": {
        const { data: profile } = await supabase
          .from("driver_profiles")
          .select("contact_name, contact_phone, car_brand, car_color, car_plate")
          .eq("user_id", existingUser.id)
          .maybeSingle();
        return json({ user: existingUser, is_car_manager: isManager, driver_profile: profile || null });
      }

      // ---- Active events visible to this member (same group-
      // visibility rule as home-api's event list) ----
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

      // ---- Create/update the caller's persistent driver profile:
      // their own contact info PLUS car info, kept separate from the
      // shared `users` row (same reason registrations keeps its own
      // attendee_name/attendee_phone) ----
      case "save_driver_profile": {
        const contactName = (body.contact_name || "").trim();
        const contactPhone = (body.contact_phone || "").trim();
        const carBrand = (body.car_brand || "").trim();
        const carColor = (body.car_color || "").trim();
        const carPlate = (body.car_plate || "").trim();
        if (!contactName || !contactPhone) return json({ error: "請填寫司機姓名與聯絡電話。" }, 400);
        if (!carBrand || !carPlate) return json({ error: "請填寫車輛廠牌與車牌號碼。" }, 400);

        const { data, error } = await supabase
          .from("driver_profiles")
          .upsert(
            {
              user_id: existingUser.id,
              contact_name: contactName,
              contact_phone: contactPhone,
              car_brand: carBrand,
              car_color: carColor || null,
              car_plate: carPlate,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ driver_profile: data });
      }

      // ---- The caller's own trips for one event, with assigned
      // passengers ----
      case "list_my_trips": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: trips, error } = await supabase
          .from("car_trips")
          .select("id, available_date, available_time, available_time_end, departure_point, seats_total, notes, trip_status, created_at")
          .eq("event_id", event_id)
          .eq("driver_user_id", existingUser.id)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const tripIds = (trips || []).map((t: any) => t.id);
        let passengersByTrip: Record<string, any[]> = {};
        if (tripIds.length > 0) {
          const { data: assigned } = await supabase
            .from("ride_requests")
            .select("id, trip_id, passenger_name, passenger_phone, pickup_area, destination, additional_passengers, notes")
            .in("trip_id", tripIds)
            .eq("status", "assigned");
          (assigned || []).forEach((r: any) => {
            (passengersByTrip[r.trip_id] ||= []).push({
              name: r.passenger_name || "—",
              phone: r.passenger_phone || "",
              pickup_area: r.pickup_area,
              destination: r.destination,
              additional_passengers: r.additional_passengers || [],
              passenger_count: requestPassengerCount(r),
              notes: r.notes,
            });
          });
        }

        const tripsOut = (trips || []).map((t: any) => ({ ...t, passengers: passengersByTrip[t.id] || [] }));
        return json({ trips: tripsOut });
      }

      // ---- Offer a ride for one event ----
      case "create_trip": {
        const { data: profile } = await supabase
          .from("driver_profiles")
          .select("user_id")
          .eq("user_id", existingUser.id)
          .maybeSingle();
        if (!profile) return json({ error: "請先登記車輛資訊，才能提供共乘。" }, 400);

        const { event_id, available_date, available_time, available_time_end, departure_point, seats_total, notes } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);
        if (!departure_point || !String(departure_point).trim()) return json({ error: "請填寫等待派送點。" }, 400);
        const seats = parseInt(seats_total, 10);
        if (!seats || seats < 1) return json({ error: "請填寫有效的座位數。" }, 400);

        const { data, error } = await supabase
          .from("car_trips")
          .insert({
            event_id,
            driver_user_id: existingUser.id,
            available_date: (available_date || "").trim() || null,
            available_time: (available_time || "").trim() || null,
            available_time_end: (available_time_end || "").trim() || null,
            departure_point: String(departure_point).trim(),
            seats_total: seats,
            notes: (notes || "").trim() || null,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ trip: data });
      }

      // ---- Delete a trip the caller themselves posted ----
      case "delete_trip": {
        const { trip_id } = body;
        if (!trip_id) return json({ error: "Missing trip_id." }, 400);

        const { data: trip } = await supabase.from("car_trips").select("id, driver_user_id").eq("id", trip_id).maybeSingle();
        if (!trip || trip.driver_user_id !== existingUser.id) {
          return json({ error: "您只能刪除自己提供的共乘。" }, 403);
        }

        await supabase
          .from("ride_requests")
          .update({ status: "pending", trip_id: null, updated_at: new Date().toISOString() })
          .eq("trip_id", trip_id);

        const { error } = await supabase.from("car_trips").delete().eq("id", trip_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Driver advances their trip's status one step at a time ----
      case "update_trip_status": {
        const { trip_id, next_status } = body;
        if (!trip_id || !next_status) return json({ error: "Missing trip_id or next_status." }, 400);

        const { data: trip } = await supabase.from("car_trips").select("id, driver_user_id, trip_status").eq("id", trip_id).maybeSingle();
        if (!trip || trip.driver_user_id !== existingUser.id) {
          return json({ error: "您只能更新自己提供的共乘狀態。" }, 403);
        }

        const currentIdx = DRIVER_STATUS_ORDER.indexOf(trip.trip_status);
        const nextIdx = DRIVER_STATUS_ORDER.indexOf(next_status);
        if (currentIdx === -1 || nextIdx !== currentIdx + 1) {
          return json({ error: "狀態只能依序推進，請重新整理頁面。" }, 400);
        }

        const { data, error } = await supabase
          .from("car_trips")
          .update({ trip_status: next_status })
          .eq("id", trip_id)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ trip: data });
      }

      // ---- Driver updates where their car is currently waiting
      // (the "等待派送點"), independently of the trip status. The
      // driver's location can change while they wait for a dispatch,
      // so they should keep this current — it's what the Car Manager
      // uses to assign rides efficiently. ----
      case "update_trip_location": {
        const { trip_id, departure_point } = body;
        if (!trip_id) return json({ error: "Missing trip_id." }, 400);
        const point = String(departure_point || "").trim();
        if (!point) return json({ error: "請填寫等待派送點。" }, 400);

        const { data: trip } = await supabase.from("car_trips").select("id, driver_user_id").eq("id", trip_id).maybeSingle();
        if (!trip || trip.driver_user_id !== existingUser.id) {
          return json({ error: "您只能更新自己提供的共乘位置。" }, 403);
        }

        const { data, error } = await supabase
          .from("car_trips")
          .update({ departure_point: point })
          .eq("id", trip_id)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ trip: data });
      }

      // ---- The caller's own active ride request for one event ----
      case "get_my_ride_request": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: reqRow } = await supabase
          .from("ride_requests")
          .select(
            "id, status, pickup_area, destination, additional_passengers, notes, trip_id, car_trips ( driver_user_id, available_date, available_time, available_time_end, departure_point, trip_status )"
          )
          .eq("event_id", event_id)
          .eq("user_id", existingUser.id)
          .in("status", ["pending", "assigned"])
          .maybeSingle();

        if (!reqRow) return json({ request: null });

        const trip = reqRow.car_trips as any;
        let driverProfile: any = null;
        if (trip) {
          const { data: profile } = await supabase
            .from("driver_profiles")
            .select("contact_name, contact_phone, car_brand, car_color, car_plate")
            .eq("user_id", trip.driver_user_id)
            .maybeSingle();
          driverProfile = profile;
        }

        return json({
          request: {
            id: reqRow.id,
            status: reqRow.status,
            pickup_area: reqRow.pickup_area,
            destination: reqRow.destination,
            additional_passengers: reqRow.additional_passengers || [],
            notes: reqRow.notes,
            trip: trip
              ? {
                  available_date: trip.available_date,
                  available_time: trip.available_time,
                  available_time_end: trip.available_time_end,
                  departure_point: trip.departure_point,
                  trip_status: trip.trip_status,
                  driver_name: driverProfile?.contact_name || "—",
                  driver_phone: driverProfile?.contact_phone || "",
                  car_brand: driverProfile?.car_brand || "",
                  car_color: driverProfile?.car_color || "",
                  car_plate: driverProfile?.car_plate || "",
                }
              : null,
          },
        });
      }

      // ---- Request a ride for one event ----
      case "create_ride_request": {
        const { event_id, passenger_name, passenger_phone, pickup_area, destination, notes } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const passengerName = (passenger_name || "").trim();
        const passengerPhone = (passenger_phone || "").trim();
        if (!passengerName || !passengerPhone) return json({ error: "請填寫姓名與聯絡電話。" }, 400);

        const additionalPassengers = Array.isArray(body.additional_passengers)
          ? body.additional_passengers.map((n: unknown) => String(n || "").trim()).filter((n: string) => n.length > 0)
          : [];

        const { data, error } = await supabase
          .from("ride_requests")
          .insert({
            event_id,
            user_id: existingUser.id,
            passenger_name: passengerName,
            passenger_phone: passengerPhone,
            pickup_area: (pickup_area || "").trim() || null,
            destination: (destination || "").trim() || null,
            additional_passengers: additionalPassengers,
            notes: (notes || "").trim() || null,
          })
          .select()
          .single();

        if (error) {
          if (error.message.includes("duplicate")) {
            return json({ error: "您已經送出過共乘需求，如需修改請先取消，再重新送出。" }, 400);
          }
          return json({ error: error.message }, 400);
        }
        return json({ request: data });
      }

      // ---- Cancel the caller's own ride request ----
      case "cancel_ride_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);

        const { data: reqRow } = await supabase.from("ride_requests").select("id, user_id").eq("id", request_id).maybeSingle();
        if (!reqRow || reqRow.user_id !== existingUser.id) {
          return json({ error: "您只能取消自己的共乘需求。" }, 403);
        }

        const { error } = await supabase
          .from("ride_requests")
          .update({ status: "cancelled", trip_id: null, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Passenger confirms drop-off ("感謝天恩師德"), closing
      // this one-time ride. Only allowed once the driver has marked
      // the trip "已抵達目的地". Marks the request completed and,
      // once no other passenger on the same trip is still assigned,
      // frees the driver by setting the trip back to idle — no Car
      // Manager involvement needed for this normal completion path.
      case "complete_ride_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);

        const { data: reqRow } = await supabase
          .from("ride_requests")
          .select("id, user_id, status, trip_id")
          .eq("id", request_id)
          .maybeSingle();
        if (!reqRow || reqRow.user_id !== existingUser.id) {
          return json({ error: "您只能確認自己的共乘需求。" }, 403);
        }
        if (reqRow.status !== "assigned" || !reqRow.trip_id) {
          return json({ error: "此共乘尚未配對司機。" }, 400);
        }

        const { data: trip } = await supabase
          .from("car_trips")
          .select("id, trip_status")
          .eq("id", reqRow.trip_id)
          .maybeSingle();
        if (!trip || trip.trip_status !== "arrived_destination") {
          return json({ error: "司機尚未標記「已抵達目的地」，請稍候再確認。" }, 400);
        }

        const { data, error } = await supabase
          .from("ride_requests")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", request_id)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);

        // If no other passenger on this trip is still assigned, the
        // driver is free again — set the trip back to idle.
        const { count } = await supabase
          .from("ride_requests")
          .select("id", { count: "exact", head: true })
          .eq("trip_id", reqRow.trip_id)
          .eq("status", "assigned");
        if (!count) {
          await supabase.from("car_trips").update({ trip_status: "idle" }).eq("id", reqRow.trip_id);
        }

        return json({ request: data });
      }

      // =========================================================
      // CAR MANAGER ACTIONS — gated by car_manager_admins above.
      // =========================================================

      case "list_trips_for_event": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data: trips, error } = await supabase
          .from("car_trips")
          .select("id, driver_user_id, available_date, available_time, available_time_end, departure_point, seats_total, notes, trip_status, created_at")
          .eq("event_id", event_id)
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const tripIds = (trips || []).map((t: any) => t.id);
        const driverIds = (trips || []).map((t: any) => t.driver_user_id);

        let passengersByTrip: Record<string, any[]> = {};
        if (tripIds.length > 0) {
          const { data: assigned } = await supabase
            .from("ride_requests")
            .select("id, trip_id, passenger_name, passenger_phone, pickup_area, destination, additional_passengers, notes")
            .in("trip_id", tripIds)
            .eq("status", "assigned");
          (assigned || []).forEach((r: any) => {
            (passengersByTrip[r.trip_id] ||= []).push({
              request_id: r.id,
              name: r.passenger_name || "—",
              phone: r.passenger_phone || "",
              pickup_area: r.pickup_area,
              destination: r.destination,
              additional_passengers: r.additional_passengers || [],
              passenger_count: requestPassengerCount(r),
              notes: r.notes,
            });
          });
        }

        let profileByDriver: Record<string, any> = {};
        if (driverIds.length > 0) {
          const { data: profiles } = await supabase
            .from("driver_profiles")
            .select("user_id, contact_name, contact_phone, car_brand, car_color, car_plate")
            .in("user_id", driverIds);
          (profiles || []).forEach((p: any) => { profileByDriver[p.user_id] = p; });
        }

        const tripsOut = (trips || []).map((t: any) => {
          const profile = profileByDriver[t.driver_user_id];
          return {
            id: t.id,
            driver_name: profile?.contact_name || "—",
            driver_phone: profile?.contact_phone || "",
            car_brand: profile?.car_brand || "",
            car_color: profile?.car_color || "",
            car_plate: profile?.car_plate || "",
            available_date: t.available_date,
            available_time: t.available_time,
            available_time_end: t.available_time_end,
            departure_point: t.departure_point,
            seats_total: t.seats_total,
            notes: t.notes,
            trip_status: t.trip_status,
            passengers: passengersByTrip[t.id] || [],
          };
        });
        return json({ trips: tripsOut });
      }

      case "list_requests_for_event": {
        const { event_id } = body;
        if (!event_id) return json({ error: "Missing event_id." }, 400);

        const { data, error } = await supabase
          .from("ride_requests")
          .select("id, status, passenger_name, passenger_phone, pickup_area, destination, additional_passengers, notes, trip_id, created_at")
          .eq("event_id", event_id)
          .neq("status", "cancelled")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const requests = (data || []).map((r: any) => ({
          id: r.id,
          status: r.status,
          pickup_area: r.pickup_area,
          destination: r.destination,
          additional_passengers: r.additional_passengers || [],
          passenger_count: requestPassengerCount(r),
          notes: r.notes,
          trip_id: r.trip_id,
          name: r.passenger_name || "—",
          phone: r.passenger_phone || "",
        }));
        return json({ requests });
      }

      case "assign_ride_request": {
        const { request_id, trip_id } = body;
        if (!request_id || !trip_id) return json({ error: "Missing request_id or trip_id." }, 400);

        const { data: trip } = await supabase.from("car_trips").select("id, seats_total").eq("id", trip_id).maybeSingle();
        if (!trip) return json({ error: "找不到此共乘車輛。" }, 404);

        const { data: requestRow } = await supabase
          .from("ride_requests")
          .select("id, additional_passengers")
          .eq("id", request_id)
          .maybeSingle();
        if (!requestRow) return json({ error: "找不到此共乘申請。" }, 404);
        const requestSeats = requestPassengerCount(requestRow);

        const { data: assignedRows } = await supabase
          .from("ride_requests")
          .select("additional_passengers")
          .eq("trip_id", trip_id)
          .eq("status", "assigned");
        const usedSeats = (assignedRows || []).reduce((sum: number, r: any) => sum + requestPassengerCount(r), 0);

        if (usedSeats + requestSeats > trip.seats_total) {
          return json({ error: "此車輛座位不足，請選擇其他車輛或增加座位數。" }, 400);
        }

        const { error } = await supabase
          .from("ride_requests")
          .update({ status: "assigned", trip_id, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "unassign_ride_request": {
        const { request_id } = body;
        if (!request_id) return json({ error: "Missing request_id." }, 400);
        const { error } = await supabase
          .from("ride_requests")
          .update({ status: "pending", trip_id: null, updated_at: new Date().toISOString() })
          .eq("id", request_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ---- Manager marks a trip that finished its run (arrived at
      // destination) as idle again, freeing the driver ----
      case "mark_trip_idle": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);

        const { data: trip } = await supabase.from("car_trips").select("id, trip_status").eq("id", id).maybeSingle();
        if (!trip) return json({ error: "找不到此共乘車輛。" }, 404);
        if (trip.trip_status !== "arrived_destination") {
          return json({ error: "只有已抵達目的地的共乘，才能標記為待命中。" }, 400);
        }

        const { data, error } = await supabase.from("car_trips").update({ trip_status: "idle" }).eq("id", id).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ trip: data });
      }

      case "manager_delete_trip": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        await supabase
          .from("ride_requests")
          .update({ status: "pending", trip_id: null, updated_at: new Date().toISOString() })
          .eq("trip_id", id);
        const { error } = await supabase.from("car_trips").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "manager_delete_ride_request": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { error } = await supabase.from("ride_requests").delete().eq("id", id);
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
