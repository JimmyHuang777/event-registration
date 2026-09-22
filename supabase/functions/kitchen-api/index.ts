// =========================================================
// SUPABASE EDGE FUNCTION: kitchen-api
//
// Backs kitchen.html — 天廚 (kitchen), one of the three teams every
// 壇 (altar/location) has under 壇務運作系統. Fully scoped per
// altar via altar_team_members (unlike 佛堂/庶務, which reuse the
// existing Task system with only a soft, by-convention scoping —
// see 33-altars-and-kitchen.sql's header comment for why).
//
// Two roles within a kitchen team, both membership rows in
// altar_team_members (team = 'kitchen'):
//   - 天廚組長 (leader) — maintains a reusable recipe library
//                        (食譜), builds dated menus (菜單) from
//                        those recipes, and creates cooking tasks
//                        (either pre-assigned or left open for
//                        members to claim).
//   - 組員 (member)      — sees the altar's menus, and claims/
//                        completes open cooking tasks.
//
// Actions:
//   whoami                — registers/looks up the caller's `users`
//                           row.
//   list_my_kitchen_altars — every altar where the caller is on the
//                           kitchen team, with their role there.
//   list_recipes           — a kitchen team member/leader's altar's
//                           recipe library.
//   save_recipe            — create/update a recipe (leader only).
//   delete_recipe          — remove a recipe (leader only).
//   list_menus              — menus (with their recipe items) for an
//                           altar, in a date range.
//   save_menu               — create/update a dated menu + its
//                           recipe items (leader only).
//   delete_menu             — remove a menu (leader only; cascades
//                           its items and unlinks its tasks).
//   list_tasks               — an altar's cooking tasks (recent +
//                           upcoming), for the claim board.
//   add_task                 — create a cooking task, optionally
//                           pre-assigned (leader only).
//   claim_task                — member self-claims an open task.
//   unclaim_task               — assignee releases a task back to
//                           open.
//   complete_task              — assignee (or the leader) marks a
//                           task done.
//   delete_task                — remove a task (leader only).
//   list_altar_members          — the kitchen team roster for an
//                           altar (leader only — for the assignee
//                           picker).
//
// DEPLOY: this repo's GitHub Actions workflow deploys it
// automatically on push to supabase/functions/kitchen-api/**.
// Deployed with --no-verify-jwt (this function does its own auth
// via the LINE ID token — see the workflow file).
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

// Looks up the caller's membership row for one altar's kitchen team.
// Returns null if they're not on it at all.
async function getKitchenMembership(userId: string, altarId: string) {
  const { data } = await supabase
    .from("altar_team_members")
    .select("role")
    .eq("altar_id", altarId)
    .eq("team", "kitchen")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? data.role : null;
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

    switch (action) {
      case "whoami": {
        return json({ user: existingUser });
      }

      // ---- Every altar the caller is on the kitchen team for ----
      case "list_my_kitchen_altars": {
        const { data: memberships } = await supabase
          .from("altar_team_members")
          .select("altar_id, role")
          .eq("team", "kitchen")
          .eq("user_id", existingUser.id);
        const altarIds = (memberships || []).map((m: any) => m.altar_id);
        if (altarIds.length === 0) return json({ altars: [] });

        const { data: altars } = await supabase.from("altars").select("id, name").in("id", altarIds);
        const roleByAltar = new Map((memberships || []).map((m: any) => [m.altar_id, m.role]));
        return json({
          altars: (altars || []).map((a: any) => ({ id: a.id, name: a.name, role: roleByAltar.get(a.id) || "member" })),
        });
      }

      // ---- Recipe library ----
      case "list_recipes": {
        const { altar_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if (!(await getKitchenMembership(existingUser.id, altar_id))) {
          return json({ error: "您不是這個壇的天廚組成員。" }, 403);
        }
        const { data, error } = await supabase
          .from("kitchen_recipes")
          .select("*")
          .eq("altar_id", altar_id)
          .order("name", { ascending: true });
        if (error) return json({ error: error.message }, 400);
        return json({ recipes: data || [] });
      }

      case "save_recipe": {
        const { id, altar_id, name, ingredients, steps, servings } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if ((await getKitchenMembership(existingUser.id, altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以編輯食譜。" }, 403);
        }
        const cleanName = (name || "").trim();
        if (!cleanName) return json({ error: "請填寫食譜名稱。" }, 400);

        const payload = {
          altar_id,
          name: cleanName,
          ingredients: ingredients ? String(ingredients).trim() : null,
          steps: steps ? String(steps).trim() : null,
          servings: servings ? Math.max(1, parseInt(String(servings), 10) || null) : null,
          created_by: existingUser.id,
        };

        if (id) {
          const { error } = await supabase.from("kitchen_recipes").update(payload).eq("id", id);
          if (error) return json({ error: error.message }, 400);
          return json({ success: true, id });
        } else {
          const { data, error } = await supabase.from("kitchen_recipes").insert(payload).select().single();
          if (error) return json({ error: error.message }, 400);
          return json({ success: true, id: data.id });
        }
      }

      case "delete_recipe": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { data: recipe } = await supabase.from("kitchen_recipes").select("altar_id").eq("id", id).maybeSingle();
        if (!recipe) return json({ error: "找不到這個食譜。" }, 404);
        if ((await getKitchenMembership(existingUser.id, recipe.altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以刪除食譜。" }, 403);
        }
        const { error } = await supabase.from("kitchen_recipes").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Dated menus, built from the recipe library ----
      case "list_menus": {
        const { altar_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if (!(await getKitchenMembership(existingUser.id, altar_id))) {
          return json({ error: "您不是這個壇的天廚組成員。" }, 403);
        }
        const from = body.from || new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const to = body.to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

        const { data: menus, error } = await supabase
          .from("kitchen_menus")
          .select("*")
          .eq("altar_id", altar_id)
          .gte("menu_date", from)
          .lte("menu_date", to)
          .order("menu_date", { ascending: true });
        if (error) return json({ error: error.message }, 400);

        const menuIds = (menus || []).map((m: any) => m.id);
        const { data: items } = menuIds.length
          ? await supabase.from("kitchen_menu_items").select("*").in("menu_id", menuIds)
          : { data: [] };
        const recipeIds = [...new Set((items || []).map((i: any) => i.recipe_id))];
        const { data: recipes } = recipeIds.length
          ? await supabase.from("kitchen_recipes").select("id, name").in("id", recipeIds)
          : { data: [] };
        const recipeById = new Map((recipes || []).map((r: any) => [r.id, r.name]));

        const result = (menus || []).map((m: any) => ({
          ...m,
          items: (items || [])
            .filter((i: any) => i.menu_id === m.id)
            .map((i: any) => ({ id: i.id, recipe_id: i.recipe_id, recipe_name: recipeById.get(i.recipe_id) || "—", notes: i.notes })),
        }));
        return json({ menus: result });
      }

      case "save_menu": {
        const { id, altar_id, menu_date, meal, notes, recipe_ids } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if ((await getKitchenMembership(existingUser.id, altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以編輯菜單。" }, 403);
        }
        if (!menu_date) return json({ error: "請選擇日期。" }, 400);
        const cleanMeal = ["breakfast", "lunch", "dinner", "none"].includes(meal) ? meal : "none";

        const payload = {
          altar_id,
          menu_date,
          meal: cleanMeal,
          notes: notes ? String(notes).trim() : null,
          created_by: existingUser.id,
        };

        let menuId = id || null;
        if (menuId) {
          const { error } = await supabase.from("kitchen_menus").update(payload).eq("id", menuId);
          if (error) return json({ error: error.message }, 400);
        } else {
          const { data, error } = await supabase.from("kitchen_menus").insert(payload).select().single();
          if (error) {
            if (error.message.includes("duplicate")) return json({ error: "這個日期／餐別已經有菜單了。" }, 400);
            return json({ error: error.message }, 400);
          }
          menuId = data.id;
        }

        // Sync menu items: same diff pattern as the Task system's
        // subtasks — delete removed, insert new.
        const wantRecipeIds = Array.isArray(recipe_ids) ? recipe_ids : [];
        const { data: existingItems } = await supabase.from("kitchen_menu_items").select("id, recipe_id").eq("menu_id", menuId);
        const existingRecipeIds = (existingItems || []).map((r: any) => r.recipe_id);
        const toRemove = (existingItems || []).filter((r: any) => !wantRecipeIds.includes(r.recipe_id)).map((r: any) => r.id);
        const toAdd = wantRecipeIds.filter((rid: string) => !existingRecipeIds.includes(rid));

        if (toRemove.length > 0) await supabase.from("kitchen_menu_items").delete().in("id", toRemove);
        if (toAdd.length > 0) await supabase.from("kitchen_menu_items").insert(toAdd.map((recipe_id: string) => ({ menu_id: menuId, recipe_id })));

        return json({ success: true, id: menuId });
      }

      case "delete_menu": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { data: menu } = await supabase.from("kitchen_menus").select("altar_id").eq("id", id).maybeSingle();
        if (!menu) return json({ error: "找不到這個菜單。" }, 404);
        if ((await getKitchenMembership(existingUser.id, menu.altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以刪除菜單。" }, 403);
        }
        const { error } = await supabase.from("kitchen_menus").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Cooking tasks ----
      case "list_tasks": {
        const { altar_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if (!(await getKitchenMembership(existingUser.id, altar_id))) {
          return json({ error: "您不是這個壇的天廚組成員。" }, 403);
        }
        const { data: tasks, error } = await supabase
          .from("kitchen_tasks")
          .select("*")
          .eq("altar_id", altar_id)
          .order("status", { ascending: true })
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 400);

        const assigneeIds = [...new Set((tasks || []).map((t: any) => t.assignee_user_id).filter(Boolean))];
        const { data: assignees } = assigneeIds.length
          ? await supabase.from("users").select("id, display_name").in("id", assigneeIds)
          : { data: [] };
        const nameById = new Map((assignees || []).map((u: any) => [u.id, u.display_name]));

        return json({
          tasks: (tasks || []).map((t: any) => ({
            ...t,
            assignee_name: t.assignee_user_id ? nameById.get(t.assignee_user_id) || "—" : null,
            is_mine: t.assignee_user_id === existingUser.id,
          })),
        });
      }

      case "add_task": {
        const { altar_id, menu_id, content, assignee_user_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if ((await getKitchenMembership(existingUser.id, altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以新增工作。" }, 403);
        }
        const cleanContent = (content || "").trim();
        if (!cleanContent) return json({ error: "請填寫工作內容。" }, 400);

        const { data, error } = await supabase
          .from("kitchen_tasks")
          .insert({
            altar_id,
            menu_id: menu_id || null,
            content: cleanContent,
            assignee_user_id: assignee_user_id || null,
            status: assignee_user_id ? "claimed" : "open",
            created_by: existingUser.id,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ success: true, task: data });
      }

      case "claim_task": {
        const { task_id } = body;
        if (!task_id) return json({ error: "Missing task_id." }, 400);
        const { data: task } = await supabase.from("kitchen_tasks").select("altar_id, status").eq("id", task_id).maybeSingle();
        if (!task) return json({ error: "找不到這個工作。" }, 404);
        if (!(await getKitchenMembership(existingUser.id, task.altar_id))) {
          return json({ error: "您不是這個壇的天廚組成員。" }, 403);
        }
        if (task.status !== "open") return json({ error: "這個工作已經被認領了。" }, 400);
        const { error } = await supabase
          .from("kitchen_tasks")
          .update({ assignee_user_id: existingUser.id, status: "claimed" })
          .eq("id", task_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "unclaim_task": {
        const { task_id } = body;
        if (!task_id) return json({ error: "Missing task_id." }, 400);
        const { data: task } = await supabase.from("kitchen_tasks").select("assignee_user_id, status").eq("id", task_id).maybeSingle();
        if (!task || task.assignee_user_id !== existingUser.id) {
          return json({ error: "您只能放棄自己認領的工作。" }, 403);
        }
        const { error } = await supabase.from("kitchen_tasks").update({ assignee_user_id: null, status: "open" }).eq("id", task_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "complete_task": {
        const { task_id } = body;
        if (!task_id) return json({ error: "Missing task_id." }, 400);
        const { data: task } = await supabase.from("kitchen_tasks").select("altar_id, assignee_user_id").eq("id", task_id).maybeSingle();
        if (!task) return json({ error: "找不到這個工作。" }, 404);
        const role = await getKitchenMembership(existingUser.id, task.altar_id);
        if (task.assignee_user_id !== existingUser.id && role !== "leader") {
          return json({ error: "您只能完成自己認領的工作。" }, 403);
        }
        const { error } = await supabase.from("kitchen_tasks").update({ status: "done" }).eq("id", task_id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      case "delete_task": {
        const { id } = body;
        if (!id) return json({ error: "Missing id." }, 400);
        const { data: task } = await supabase.from("kitchen_tasks").select("altar_id").eq("id", id).maybeSingle();
        if (!task) return json({ error: "找不到這個工作。" }, 404);
        if ((await getKitchenMembership(existingUser.id, task.altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以刪除工作。" }, 403);
        }
        const { error } = await supabase.from("kitchen_tasks").delete().eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ success: true });
      }

      // ---- Roster, for the assignee picker (leader only) ----
      case "list_altar_members": {
        const { altar_id } = body;
        if (!altar_id) return json({ error: "Missing altar_id." }, 400);
        if ((await getKitchenMembership(existingUser.id, altar_id)) !== "leader") {
          return json({ error: "只有天廚組長可以查看組員名單。" }, 403);
        }
        const { data: members } = await supabase
          .from("altar_team_members")
          .select("user_id, role")
          .eq("altar_id", altar_id)
          .eq("team", "kitchen");
        const userIds = (members || []).map((m: any) => m.user_id);
        const { data: users } = userIds.length
          ? await supabase.from("users").select("id, display_name").in("id", userIds)
          : { data: [] };
        const nameById = new Map((users || []).map((u: any) => [u.id, u.display_name]));
        return json({
          members: (members || []).map((m: any) => ({ user_id: m.user_id, role: m.role, name: nameById.get(m.user_id) || "—" })),
        });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
