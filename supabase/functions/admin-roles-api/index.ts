// =========================================================
// SUPABASE EDGE FUNCTION: admin-roles-api
//
// Backs the Dashboard's 「管理員角色 Admin Roles」 panel (Super Admin only).
// Dashboard accounts are Supabase Auth users (email + password); their
// roles live in `admin_roles`:
//   super_admin — whole system
//   organizer   — one event (full control of its registrations)
//   staff       — one event (check-in only)
//
// Auth: the caller sends their Supabase session token (accessToken); it is
// verified here and must belong to a super_admin. Needs the service role
// to look up / create auth users by email.
//
// Actions:
//   list         — every role row with the account's email + event name
//   add_role     — { email, role, event_id?, password? }
//                  Uses the existing account for that email; if none exists
//                  and a password (>= 8 chars) is given, creates the account.
//   remove_role  — { id }  (the last super_admin can never be removed)
//
// DEPLOY: GitHub Actions workflow (--no-verify-jwt), like the others.
// =========================================================

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

const ROLES = ["super_admin", "organizer", "staff"];

async function findUserByEmail(email: string) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u: any) => (u.email || "").toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { action, accessToken } = body;
    if (!accessToken) return json({ error: "Missing accessToken." }, 401);

    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    if (userErr || !userData?.user) return json({ error: "Not authenticated." }, 401);
    const callerId = userData.user.id;

    const { data: callerRole } = await supabase
      .from("admin_roles")
      .select("id")
      .eq("admin_user_id", callerId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (!callerRole) return json({ error: "Only Super Admins can manage roles." }, 403);

    switch (action) {
      case "list": {
        const { data: rows, error } = await supabase
          .from("admin_roles")
          .select("id, admin_user_id, role, event_id, created_at")
          .order("created_at", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const eventIds = [...new Set((rows || []).map((r: any) => r.event_id).filter(Boolean))];
        const eventNames: Record<string, string> = {};
        if (eventIds.length > 0) {
          const { data: evs } = await supabase.from("events").select("id, name").in("id", eventIds);
          (evs || []).forEach((e: any) => { eventNames[e.id] = e.name; });
        }

        const emails: Record<string, string> = {};
        for (const uid of new Set((rows || []).map((r: any) => r.admin_user_id))) {
          const { data } = await supabase.auth.admin.getUserById(uid as string);
          emails[uid as string] = data?.user?.email || "(unknown)";
        }

        return json({
          roles: (rows || []).map((r: any) => ({
            id: r.id,
            email: emails[r.admin_user_id],
            role: r.role,
            event_id: r.event_id,
            event_name: r.event_id ? eventNames[r.event_id] || "(已刪除的活動)" : null,
            created_at: r.created_at,
            is_me: r.admin_user_id === callerId,
          })),
        });
      }

      case "add_role": {
        const email = String(body.email || "").trim().toLowerCase();
        const role = String(body.role || "");
        const eventId = body.event_id || null;
        const password = body.password ? String(body.password) : "";

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "請輸入正確的 Email。" }, 400);
        if (!ROLES.includes(role)) return json({ error: "角色不正確。" }, 400);
        if (role === "super_admin" && eventId) return json({ error: "超級管理員不需要指定活動。" }, 400);
        if (role !== "super_admin" && !eventId) return json({ error: "主辦與報到人員必須指定活動。" }, 400);
        if (eventId) {
          const { data: ev } = await supabase.from("events").select("id").eq("id", eventId).maybeSingle();
          if (!ev) return json({ error: "找不到這個活動。" }, 400);
        }

        let user = await findUserByEmail(email);
        let created = false;
        if (!user) {
          if (password.length < 8) {
            return json({ error: "這個 Email 還沒有 Dashboard 帳號。請設定一組至少 8 碼的初始密碼來建立帳號。", need_password: true }, 400);
          }
          const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
          if (error) return json({ error: error.message }, 400);
          user = data.user;
          created = true;
        }

        let dupQuery = supabase.from("admin_roles").select("id").eq("admin_user_id", user!.id).eq("role", role);
        dupQuery = eventId ? dupQuery.eq("event_id", eventId) : dupQuery.is("event_id", null);
        const { data: dup } = await dupQuery.maybeSingle();
        if (dup) return json({ error: "這個帳號已經有相同的角色了。" }, 409);

        const { error: insErr } = await supabase
          .from("admin_roles")
          .insert({ admin_user_id: user!.id, role, event_id: eventId });
        if (insErr) return json({ error: insErr.message }, 400);
        return json({ ok: true, account_created: created });
      }

      case "remove_role": {
        const id = body.id;
        if (!id) return json({ error: "Missing id." }, 400);
        const { data: row } = await supabase.from("admin_roles").select("id, role").eq("id", id).maybeSingle();
        if (!row) return json({ error: "找不到這個角色。" }, 404);
        if (row.role === "super_admin") {
          const { count } = await supabase
            .from("admin_roles")
            .select("id", { count: "exact", head: true })
            .eq("role", "super_admin");
          if ((count || 0) <= 1) return json({ error: "不能移除最後一位超級管理員。" }, 400);
        }
        const { error } = await supabase.from("admin_roles").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "伺服器發生錯誤，請稍後再試。Server error." }, 500);
  }
});
