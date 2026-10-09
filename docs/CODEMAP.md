# 程式地圖（CODEMAP）

> 由 `docs/tools/gen_codemap.py` 自動產生，請勿手改。內容為掃描程式得到的近似地圖。
> 查「某功能改哪裡」時先看這份：頁面 → 用到哪個函式／動作 → 讀寫哪些表 → Dashboard 哪個區段。

## 1. Edge Function（動作與資料表）

### admin-roles-api

- 資料表（整個函式）：`admin_roles`, `events`

| 動作 | 直接用到的資料表 |
|---|---|
| `list` | `admin_roles`, `events` |
| `add_role` | `events`, `admin_roles` |
| `remove_role` | `admin_roles` |

### altar-team-api

- 資料表（整個函式）：`users`, `task_job_admins`, `altar_team_members`, `task_groups`, `task_group_members`, `altar_team_swaps`, `altar_team_rules`, `altar_team_rule_rows`, `altar_team_handover_items`

| 動作 | 直接用到的資料表 |
|---|---|
| `overview` | `altar_team_members`, `altar_team_swaps`, `users` |
| `members_list` | `altar_team_members`, `users` |
| `members_search` | `altar_team_members`, `users` |
| `member_add` | `altar_team_members` |
| `member_remove` | `altar_team_members` |
| `rules_list` | `altar_team_rules`, `altar_team_rule_rows` |
| `rule_save` | `altar_team_rules`, `altar_team_rule_rows` |
| `rule_delete` | `altar_team_rules` |
| `handover_list` | `altar_team_handover_items`, `users` |
| `handover_save` | `altar_team_handover_items` |
| `handover_delete` | `altar_team_handover_items` |
| `handover_toggle` | `altar_team_handover_items` |
| `handover_reset` | `altar_team_handover_items` |
| `swap_propose` | `altar_team_swaps` |
| `swap_respond` | `altar_team_swaps` |
| `swap_cancel` | `altar_team_swaps` |

### calendar-api

- 資料表（整個函式）：`users`, `task_group_members`, `calendar_entries`, `events`, `event_groups`, `task_instances`, `task_template_groups`, `altars`

### carpool-api

- 資料表（整個函式）：`car_manager_admins`, `users`, `driver_profiles`, `task_group_members`, `events`, `event_groups`, `car_trips`, `ride_requests`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | `driver_profiles` |
| `list_active_events` | `task_group_members`, `events`, `event_groups` |
| `save_driver_profile` | `driver_profiles` |
| `list_my_trips` | `car_trips`, `ride_requests` |
| `create_trip` | `driver_profiles`, `car_trips` |
| `delete_trip` | `car_trips`, `ride_requests` |
| `update_trip_status` | `car_trips` |
| `update_trip_location` | `car_trips` |
| `get_my_ride_request` | `ride_requests`, `driver_profiles` |
| `create_ride_request` | `ride_requests`, `events` |
| `cancel_ride_request` | `ride_requests` |
| `complete_ride_request` | `ride_requests`, `car_trips` |
| `list_trips_for_event` | `car_trips`, `ride_requests`, `driver_profiles` |
| `list_requests_for_event` | `ride_requests` |
| `assign_ride_request` | `car_trips`, `ride_requests` |
| `unassign_ride_request` | `ride_requests` |
| `mark_trip_idle` | `car_trips` |
| `manager_delete_trip` | `ride_requests`, `car_trips` |
| `manager_delete_ride_request` | `ride_requests` |

### create-liff-app

- 資料表（整個函式）：`admin_roles`, `liff_apps`

### events-admin-api

- 資料表（整個函式）：`event_groups`, `users`, `event_admins`, `altar_manager_teams`, `altar_team_members`, `events`, `train_schedule`, `altars`, `task_groups`, `registrations`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | （呼叫共用函式） |
| `list_events` | `events`, `event_groups` |
| `list_trains` | `train_schedule` |
| `list_altars` | `altars` |
| `list_groups` | `task_groups` |
| `save_event` | `events` |
| `list_registrations` | `events`, `registrations` |
| `set_registration_status` | `registrations` |
| `toggle_event_active` | `events` |
| `delete_event` | `events` |

### flow-admin-api

- 資料表（整個函式）：`users`, `activity_flow_admins`, `activity_flows`, `activity_flow_items`, `activity_flow_groups`, `altars`, `task_groups`, `activity_flow_presets`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | （呼叫共用函式） |
| `list_flows` | `activity_flows`, `activity_flow_items`, `activity_flow_groups` |
| `list_altars` | `altars` |
| `list_groups` | `task_groups` |
| `list_presets` | `activity_flow_presets` |
| `save_preset` | `activity_flow_presets` |
| `delete_preset` | `activity_flow_presets` |
| `save_flow` | `activity_flows`, `activity_flow_items`, `activity_flow_groups` |
| `toggle_flow_active` | `activity_flows` |
| `delete_flow` | `activity_flows` |

### flow-api

- 資料表（整個函式）：`activity_flows`, `activity_flow_groups`, `task_group_members`, `users`, `activity_flow_items`

| 動作 | 直接用到的資料表 |
|---|---|
| `list_flows` | `activity_flows`, `activity_flow_groups`, `task_group_members` |
| `get_flow` | `activity_flows`, `activity_flow_items` |

### home-api

- 資料表（整個函式）：`users`, `task_job_admins`, `activity_flow_admins`, `event_admins`, `task_group_members`, `altar_team_members`, `altar_manager_teams`, `task_groups`, `task_templates`, `task_template_groups`, `activity_flows`, `activity_flow_groups`, `events`, `event_groups`, `altars`

### kitchen-api

- 資料表（整個函式）：`altar_team_members`, `users`, `altars`, `kitchen_recipes`, `kitchen_menus`, `kitchen_menu_items`, `kitchen_tasks`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | （呼叫共用函式） |
| `list_my_kitchen_altars` | `altar_team_members`, `altars` |
| `list_recipes` | `kitchen_recipes` |
| `save_recipe` | `kitchen_recipes` |
| `delete_recipe` | `kitchen_recipes` |
| `list_menus` | `kitchen_menus`, `kitchen_menu_items`, `kitchen_recipes` |
| `save_menu` | `kitchen_menus`, `kitchen_menu_items` |
| `delete_menu` | `kitchen_menus` |
| `list_tasks` | `kitchen_tasks`, `users` |
| `add_task` | `kitchen_tasks` |
| `claim_task` | `kitchen_tasks` |
| `unclaim_task` | `kitchen_tasks` |
| `complete_task` | `kitchen_tasks` |
| `delete_task` | `kitchen_tasks` |
| `list_altar_members` | `altar_team_members`, `users` |

### lodging-api

- 資料表（整個函式）：`lodging_manager_admins`, `users`, `host_profiles`, `task_group_members`, `events`, `event_groups`, `lodging_offers`, `lodging_requests`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | `host_profiles` |
| `list_active_events` | `task_group_members`, `events`, `event_groups` |
| `save_host_profile` | `host_profiles` |
| `list_my_offers` | `lodging_offers`, `lodging_requests` |
| `create_offer` | `host_profiles`, `lodging_offers` |
| `delete_offer` | `lodging_offers`, `lodging_requests` |
| `update_offer_status` | `lodging_offers` |
| `get_my_lodging_request` | `lodging_requests`, `host_profiles` |
| `create_lodging_request` | `lodging_requests`, `events` |
| `cancel_lodging_request` | `lodging_requests` |
| `complete_lodging_request` | `lodging_requests`, `lodging_offers` |
| `list_offers_for_event` | `lodging_offers`, `lodging_requests`, `host_profiles` |
| `list_requests_for_event` | `lodging_requests` |
| `assign_lodging_request` | `lodging_offers`, `lodging_requests` |
| `unassign_lodging_request` | `lodging_requests` |
| `mark_offer_available` | `lodging_offers` |
| `manager_delete_offer` | `lodging_requests`, `lodging_offers` |
| `manager_delete_lodging_request` | `lodging_requests` |

### meeting-api

- 資料表（整個函式）：`users`, `meeting_admins`, `meeting_attendance`, `meeting_instances`, `meeting_types`, `meeting_action_items`, `task_groups`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | （呼叫共用函式） |
| `list_my_meetings` | `meeting_attendance`, `meeting_instances`, `meeting_types` |
| `get_meeting` | `meeting_attendance`, `meeting_instances`, `meeting_types`, `meeting_action_items` |
| `check_in` | `meeting_instances`, `meeting_attendance` |
| `list_my_action_items` | `meeting_action_items`, `meeting_instances`, `meeting_types` |
| `complete_action_item` | `meeting_action_items` |
| `list_groups` | `task_groups` |
| `list_meeting_types` | `meeting_types`, `task_groups` |
| `save_meeting_type` | `meeting_types` |
| `delete_meeting_type` | `meeting_types` |
| `list_upcoming_instances` | `meeting_instances`, `meeting_types`, `meeting_attendance` |
| `get_instance_detail` | `meeting_instances`, `meeting_types`, `meeting_attendance`, `users`, `meeting_action_items` |
| `mark_attendance` | `meeting_attendance` |
| `save_minutes` | `meeting_instances` |
| `add_action_item` | `meeting_action_items`, `users` |
| `update_action_item_status` | `meeting_action_items` |
| `delete_action_item` | `meeting_action_items` |

### profile-api

- 資料表（整個函式）：`users`, `user_profiles`, `family_members`

| 動作 | 直接用到的資料表 |
|---|---|
| `get_all` | `user_profiles`, `family_members` |
| `save_profile` | `user_profiles` |
| `save_family` | `family_members` |
| `delete_family` | `family_members` |

### registrant-api

- 資料表（整個函式）：`events`, `event_groups`, `task_group_members`, `event_admins`, `users`, `registrations`

| 動作 | 直接用到的資料表 |
|---|---|
| `get_my_data` | `registrations` |
| `register_for_event` | `users`, `registrations` |
| `update_attendee` | `registrations` |
| `cancel_registration` | `registrations` |
| `update_profile` | `users` |
| `delete_profile` | `users` |
| `delete_my_event_registrations` | `registrations` |

### tasks-admin-api

- 資料表（整個函式）：`task_templates`, `task_template_groups`, `task_group_members`, `users`, `task_job_admins`, `altar_team_members`, `task_groups`, `altar_manager_teams`, `altars`, `task_instances`, `task_subtask_templates`, `task_subtask_completions`, `task_job_presets`

| 動作 | 直接用到的資料表 |
|---|---|
| `whoami` | `task_template_groups` |
| `perms_list` | `users`, `altar_manager_teams`, `altar_team_members`, `altars` |
| `perms_search_users` | `users` |
| `perms_set` | （呼叫共用函式） |
| `perms_set_team` | `altar_manager_teams` |
| `list_upcoming` | `task_instances`, `task_subtask_templates`, `task_subtask_completions` |
| `search_users` | `users` |
| `assign_subtask` | `task_instances`, `task_subtask_templates`, `task_subtask_completions` |
| `unassign_subtask` | `task_subtask_completions`, `task_instances` |
| `list_templates` | `task_templates`, `task_subtask_templates`, `task_template_groups` |
| `list_altars` | `altars` |
| `list_groups` | `task_groups` |
| `list_presets` | `task_job_presets` |
| `save_template` | `task_templates`, `task_subtask_templates`, `task_template_groups` |
| `toggle_template_active` | `task_templates` |
| `delete_template` | `task_templates` |
| `save_preset` | `task_job_presets` |
| `delete_preset` | `task_job_presets` |

### tasks-api

- 資料表（整個函式）：`task_templates`, `task_template_groups`, `task_group_members`, `users`, `task_groups`, `task_instances`, `task_assignments`, `task_subtask_completions`, `task_subtask_templates`

| 動作 | 直接用到的資料表 |
|---|---|
| `my_altar_teams` | `task_groups`, `task_group_members` |
| `list_tasks` | `task_instances`, `task_templates`, `task_template_groups`, `task_group_members`, `task_groups`, `task_assignments`, `task_subtask_completions`, `task_subtask_templates` |
| `claim_task` | `users`, `task_instances`, `task_assignments` |
| `release_task` | `task_assignments` |
| `complete_task` | `task_assignments`, `task_instances`, `task_subtask_templates`, `task_subtask_completions` |
| `claim_subtask` | `users`, `task_instances`, `task_subtask_templates`, `task_subtask_completions` |
| `release_subtask` | `task_subtask_completions` |
| `complete_subtask` | `task_subtask_completions` |

## 2. LIFF 頁面 → 函式與動作

| 頁面 | 標題 | 呼叫的 Edge Function | 呼叫的動作 |
|---|---|---|---|
| activity-flow-admin.html | 開班課程表 Flow Admin | `flow-admin-api` | `list_altars`, `whoami`, `list_flows`, `list_groups`, `list_presets`, `delete_preset`, `save_preset`, `toggle_flow_active`, `delete_flow`, `save_flow` |
| activity-flow.html | 開班資訊表 Activity Flow | `flow-api` | `list_flows`, `get_flow` |
| altar-hub.html | 壇務 Altar Hub | `kitchen-api`, `tasks-api`, `altar-team-api` | `list_recipes`, `delete_recipe`, `save_recipe`, `list_menus`, `delete_menu`, `save_menu`, `list_tasks`, `list_altar_members`, `add_task`, `claim_task`, `complete_task`, `unclaim_task`, `delete_task`, `list_my_kitchen_altars`, `my_altar_teams`, `overview`, `members_list`, `member_remove`, `members_search`, `member_add`, `rules_list`, `rule_delete`, `rule_save`, `handover_list`, `handover_toggle`, `handover_save`, `handover_reset`, `handover_delete`, `swap_respond`, `swap_cancel`, `swap_propose` |
| calendar.html | 行事曆 Calendar | `calendar-api` | `month` |
| carpool.html | 共乘 Carpool | `carpool-api` | `save_driver_profile`, `list_active_events`, `list_my_trips`, `update_trip_status`, `delete_trip`, `update_trip_location`, `create_trip`, `get_my_ride_request`, `complete_ride_request`, `cancel_ride_request`, `create_ride_request`, `list_trips_for_event`, `list_requests_for_event`, `unassign_ride_request`, `mark_trip_idle`, `manager_delete_trip`, `assign_ride_request`, `manager_delete_ride_request`, `whoami` |
| event-admin.html | 活動管理 Event Admin | `events-admin-api` | `whoami`, `list_events`, `list_groups`, `toggle_event_active`, `delete_event`, `list_registrations`, `set_registration_status`, `list_trains`, `list_altars`, `save_event` |
| home.html | 群聖家園 Home | `home-api` | `get_menu` |
| index.html | 活動報名 Event Registration | `registrant-api`, `profile-api` | `update_attendee`, `cancel_registration`, `get_my_data`, `register_for_event`, `delete_my_event_registrations` |
| kitchen.html | 天廚 Kitchen | `kitchen-api` | `list_my_kitchen_altars`, `list_recipes`, `delete_recipe`, `save_recipe`, `list_menus`, `delete_menu`, `save_menu`, `list_tasks`, `list_altar_members`, `add_task`, `claim_task`, `complete_task`, `unclaim_task`, `delete_task`, `whoami` |
| lodging.html | 住宿 Lodging | `lodging-api` | `save_host_profile`, `list_active_events`, `list_my_offers`, `update_offer_status`, `delete_offer`, `create_offer`, `get_my_lodging_request`, `complete_lodging_request`, `cancel_lodging_request`, `create_lodging_request`, `list_offers_for_event`, `list_requests_for_event`, `unassign_lodging_request`, `mark_offer_available`, `manager_delete_offer`, `assign_lodging_request`, `manager_delete_lodging_request`, `whoami` |
| meetings.html | 溝通共識 Meetings | `meeting-api` | `list_my_meetings`, `get_meeting`, `check_in`, `complete_action_item`, `list_my_action_items`, `list_meeting_types`, `list_groups`, `delete_meeting_type`, `save_meeting_type`, `list_upcoming_instances`, `get_instance_detail`, `save_minutes`, `mark_attendance`, `update_action_item_status`, `delete_action_item`, `add_action_item`, `whoami` |
| profile.html | 個人資訊 Profile | `profile-api` | `save_profile`, `save_family`, `delete_family`, `get_all` |
| tasks-admin.html | 工作管理 Job Admin | `tasks-admin-api` | `list_altars`, `whoami`, `list_templates`, `list_groups`, `list_presets`, `toggle_template_active`, `delete_template`, `list_upcoming`, `unassign_subtask`, `search_users`, `assign_subtask`, `perms_list`, `perms_set`, `perms_set_team`, `perms_search_users`, `save_template`, `delete_preset`, `save_preset` |
| tasks-once.html | 單次任務 One-time Tasks | `tasks-api` | `list_tasks`, `claim_subtask`, `release_subtask`, `complete_subtask` |
| tasks.html | 了愿生活圈 Task Roster | `tasks-api` | `list_tasks`, `claim_subtask`, `release_subtask`, `complete_subtask` |

## 3. 資料表 → 哪些 Edge Function 會用

| 資料表 | Edge Function |
|---|---|
| `activity_flow_admins` | `flow-admin-api`, `home-api` |
| `activity_flow_groups` | `flow-admin-api`, `flow-api`, `home-api` |
| `activity_flow_items` | `flow-admin-api`, `flow-api` |
| `activity_flow_presets` | `flow-admin-api` |
| `activity_flows` | `flow-admin-api`, `flow-api`, `home-api` |
| `admin_roles` | `admin-roles-api`, `create-liff-app` |
| `altar_manager_teams` | `events-admin-api`, `home-api`, `tasks-admin-api` |
| `altar_team_handover_items` | `altar-team-api` |
| `altar_team_members` | `altar-team-api`, `events-admin-api`, `home-api`, `kitchen-api`, `tasks-admin-api` |
| `altar_team_rule_rows` | `altar-team-api` |
| `altar_team_rules` | `altar-team-api` |
| `altar_team_swaps` | `altar-team-api` |
| `altars` | `calendar-api`, `events-admin-api`, `flow-admin-api`, `home-api`, `kitchen-api`, `tasks-admin-api` |
| `calendar_entries` | `calendar-api` |
| `car_manager_admins` | `carpool-api` |
| `car_trips` | `carpool-api` |
| `driver_profiles` | `carpool-api` |
| `event_admins` | `events-admin-api`, `home-api`, `registrant-api` |
| `event_groups` | `calendar-api`, `carpool-api`, `events-admin-api`, `home-api`, `lodging-api`, `registrant-api` |
| `events` | `admin-roles-api`, `calendar-api`, `carpool-api`, `events-admin-api`, `home-api`, `lodging-api`, `registrant-api` |
| `family_members` | `profile-api` |
| `host_profiles` | `lodging-api` |
| `kitchen_menu_items` | `kitchen-api` |
| `kitchen_menus` | `kitchen-api` |
| `kitchen_recipes` | `kitchen-api` |
| `kitchen_tasks` | `kitchen-api` |
| `liff_apps` | `create-liff-app` |
| `lodging_manager_admins` | `lodging-api` |
| `lodging_offers` | `lodging-api` |
| `lodging_requests` | `lodging-api` |
| `meeting_action_items` | `meeting-api` |
| `meeting_admins` | `meeting-api` |
| `meeting_attendance` | `meeting-api` |
| `meeting_instances` | `meeting-api` |
| `meeting_types` | `meeting-api` |
| `registrations` | `events-admin-api`, `registrant-api` |
| `ride_requests` | `carpool-api` |
| `task_assignments` | `tasks-api` |
| `task_group_members` | `altar-team-api`, `calendar-api`, `carpool-api`, `flow-api`, `home-api`, `lodging-api`, `registrant-api`, `tasks-admin-api`, `tasks-api` |
| `task_groups` | `altar-team-api`, `events-admin-api`, `flow-admin-api`, `home-api`, `meeting-api`, `tasks-admin-api`, `tasks-api` |
| `task_instances` | `calendar-api`, `tasks-admin-api`, `tasks-api` |
| `task_job_admins` | `altar-team-api`, `home-api`, `tasks-admin-api` |
| `task_job_presets` | `tasks-admin-api` |
| `task_subtask_completions` | `tasks-admin-api`, `tasks-api` |
| `task_subtask_templates` | `tasks-admin-api`, `tasks-api` |
| `task_template_groups` | `calendar-api`, `home-api`, `tasks-admin-api`, `tasks-api` |
| `task_templates` | `home-api`, `tasks-admin-api`, `tasks-api` |
| `train_schedule` | `events-admin-api` |
| `user_profiles` | `profile-api` |
| `users` | `altar-team-api`, `calendar-api`, `carpool-api`, `events-admin-api`, `flow-admin-api`, `flow-api`, `home-api`, `kitchen-api`, `lodging-api`, `meeting-api`, `profile-api`, `registrant-api`, `tasks-admin-api`, `tasks-api` |

## 4. SQL 檔與其建立／修改的表

| 檔案 | 動到的資料表 |
|---|---|
| 39-single-liff-cleanup.sql | — |
| 40-personal-profile.sql | `user_profiles`, `family_members` |
| 45-subtask-slots.sql | `task_subtask_templates`, `task_subtask_completions` |
| 46-csv-export-templates.sql | `csv_export_templates` |
| 47-calendar-entries.sql | `calendar_entries` |
| 48-allow-duplicate-registration.sql | `events`, `registrations` |
| 49-duplicate-check-by-name.sql | — |
| 50-calendar-saint-days.sql | `calendar_entries` |
| 51-train-schedule.sql | `train_schedule` |
| 52-saint-days-fields.sql | `calendar_entries` |
| 53-altar-manager-teams.sql | `altar_manager_teams` |
| 54-review-leader-job-admins.sql | — |
| 55-subtask-checklist-fields.sql | `task_subtask_templates` |
| 56-altar-team-rules-handover-swaps.sql | `altar_team_rules`, `altar_team_rule_rows`, `altar_team_handover_items`, `altar_team_swaps` |

## 5. Dashboard（index.html）

- 總行數：8316
- 區段（行號）：

| 起始行 | 結束行 | 區段 |
|---|---|---|
| 1547 | 1585 | Auth |
| 1586 | 1627 | Roles & events |
| 1628 | 1726 | Topbar system dropdowns (道務運作系統 / 壇務運作系統 |
| 1727 | 1856 | Task view (top-right task-select dropdown) — mirrors |
| 1857 | 1902 | Content shell (stats + toolbar + table) |
| 1903 | 1910 | CSV Export |
| 1911 | 2056 | CSV export with user-added extra columns |
| 2057 | 2103 | 自動排序（報名名單） |
| 2104 | 2318 | 交通、住宿、用餐統計表（Excel） |
| 2319 | 2467 | PDF export (same data + extra columns as the CSV) |
| 2468 | 2650 | Registrants |
| 2651 | 2664 | Realtime |
| 2665 | 2679 | Helpers |
| 2680 | 3039 | New Event creation (Super Admin only) |
| 3040 | 3137 | Manage Events panel (Super Admin only) |
| 3138 | 3390 | 管理者權限矩陣 Admin Permissions (super admin) |
| 3391 | 3456 | Member Profiles (個人資訊 + 親友資訊) |
| 3457 | 3465 | Word calendar import: parsing core (pure functions) |
| 3466 | 3758 | 農曆 → 國曆（瀏覽器內建 Intl 中國曆，免外部資料） |
| 3759 | 3847 | 火車時刻管理 |
| 3848 | 3978 | 仙佛紀念日管理 |
| 3979 | 4165 | 行事曆 Calendar (Dashboard) |
| 4166 | 4403 | Word import wizard |
| 4404 | 4509 | 工作細則 Word → 已存範本 |
| 4510 | 4925 | 工作檢核表（時間／工作組／工作細則／負責人／檢核人）→ 多份工作範本 |
| 4926 | 5013 | Car Managers (global permission list) |
| 5014 | 5039 | Event picker (which event's carpool board to view) |
| 5040 | 5260 | Matching (trips + requests) for one event |
| 5261 | 5363 | Lodging Managers (global permission list) |
| 5364 | 5451 | Meeting Admins (global permission list) |
| 5452 | 5477 | Event picker (which event's lodging board to view) |
| 5478 | 5877 | Matching (offers + requests) for one event |
| 5878 | 6024 | Altar detail: 3 team rosters |
| 6025 | 6295 | 壇各組：工作細則（6W 簡流表）／交接項目／整組對調 |
| 6296 | 6350 | Dual-calendar date formatting (lunar-javascript) |
| 6351 | 6411 | Flow list |
| 6412 | 6564 | Day tabs + item builder |
| 6565 | 6752 | Flow presets (save/apply a flow sheet's content) |
| 6753 | 6853 | Flow admins modal |
| 6854 | 6918 | Templates |
| 6919 | 7054 | Subtask builder (inside the template form) |
| 7055 | 7069 | Shared altar picker (used by Task Templates, Events, |
| 7070 | 7305 | Job presets (save/apply a job's content, minus |
| 7306 | 7569 | Upcoming instances |
| 7570 | 7714 | Assignment list (detailed, searchable, exportable — |
| 7715 | 7769 | Upcoming: calendar sub-view |
| 7770 | 8124 | Assign modal |
| 8125 | 8222 | Group members modal |
| 8223 | 8316 | Job admins modal |

- 頂部入口按鈕：`new-event-btn`（＋ 新增活動 New Event）、`manage-events-btn`（管理活動 Manage）、`manage-tasks-btn`（任務管理 Tasks）、`manage-groups-btn`（群組 Groups）、`manage-flows-btn`（流程表 Flow Sheets）、`manage-home-btn`（群聖家園連結 Home Link）、`manage-calendar-btn`（行事曆 Calendar）、`manage-trains-btn`（🚆 火車時刻 Train Schedule）、`manage-saints-btn`（🕯 仙佛紀念日 Saint Days）、`manage-profiles-btn`（成員資料 Member Profiles）、`manage-admin-roles-btn`（管理員角色 Admin Roles）、`manage-perms-btn`（管理者權限 Admin Permissions）、`manage-altars-btn`（⛩️ 壇 Altars（天廚／佛堂／庶務／住壇））、`manage-carpool-btn`（🚗 共乘 Carpool）、`manage-lodging-btn`（🏠 住宿 Lodging）、`manage-meetings-btn`（🗣️ 溝通共識 Meetings）、`manage-event-admins-btn`（管理 Manage）、`manage-events-close-btn`（關閉）、`manage-job-admins-btn`（管理 Manage）、`new-template-btn`（＋ 新增工作範本 New Template）、`manage-flow-admins-btn`（管理 Manage）、`new-flow-btn`（＋ 新增流程表 New Flow Sheet）、`manage-car-managers-btn`（管理 Manage）、`manage-lodging-managers-btn`（管理 Manage）、`manage-meeting-admins-btn`（管理 Manage）

- Dashboard 直接讀寫的資料表（走 Supabase RLS）：`admin_roles`, `ride_requests`, `lodging_requests`, `events`, `csv_export_templates`, `train_schedule`, `registrations`, `event_groups`, `event_admins`, `users`, `altar_manager_teams`, `altar_team_members`, `altars`, `user_profiles`, `family_members`, `calendar_entries`, `task_instances`, `task_templates`, `task_job_presets`, `liff_apps`, `car_manager_admins`, `car_trips`, `driver_profiles`, `lodging_manager_admins`, `meeting_admins`, `lodging_offers`, `host_profiles`, `task_groups`, `task_group_members`, `altar_team_rules`, `altar_team_rule_rows`, `altar_team_handover_items`, `altar_team_swaps`, `activity_flows`, `activity_flow_items`, `activity_flow_groups`, `activity_flow_presets`, `activity_flow_admins`, `task_subtask_templates`, `task_template_groups`, `task_assignments`, `task_subtask_completions`, `group_systems`, `task_job_admins`

- Dashboard 呼叫的 Edge Function：`admin-roles-api`, `create-liff-app`

- 外部程式庫（CDN）：`@supabase/supabase-js@2`, `lunar-javascript@1.7.7/lunar.js`, `jszip/3.10.1/jszip.min.js`, `exceljs/4.4.0/exceljs.min.js`, `html2canvas/1.4.1/html2canvas.min.js`, `jspdf/2.5.1/jspdf.umd.min.js`, `xlsx/0.18.5/xlsx.full.min.js`

## 6. 手機（LIFF）與 Dashboard 的資料表寫入能力對照

> 依程式掃描：Dashboard 直接寫入（走 RLS）、LIFF 經 Edge Function 寫入。**只有一邊能寫的表**是兩邊功能差異的線索，請對照 PARITY.md 的說明。
> 掃描限制：用變數當表名的寫入（例如 `tasks-admin-api` 的 `perms_set` 透過 `PERM_TABLES` 寫入 event_admins、task_job_admins、car_manager_admins、lodging_manager_admins、meeting_admins、activity_flow_admins）掃不到；Dashboard 經 Edge Function 寫入的（admin_roles、liff_apps）也會顯示在 LIFF 那欄。

| 資料表 | Dashboard 寫入 | LIFF 寫入（函式） | 差異 |
|---|---|---|---|
| `activity_flow_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `activity_flow_groups` | delete、insert | delete、insert (flow-admin-api) |  |
| `activity_flow_items` | delete、insert、update | delete、insert、update (flow-admin-api) |  |
| `activity_flow_presets` | delete、upsert | delete、upsert (flow-admin-api) |  |
| `activity_flows` | delete、insert、update | delete、insert、update (flow-admin-api) |  |
| `admin_roles` | — | delete、insert (admin-roles-api) | 只有 LIFF 能寫 |
| `altar_manager_teams` | delete、upsert | delete、upsert (tasks-admin-api) |  |
| `altar_team_handover_items` | delete、insert、update | delete、insert、update (altar-team-api) |  |
| `altar_team_members` | delete、update、upsert | delete、update、upsert (altar-team-api) |  |
| `altar_team_rule_rows` | delete、insert | delete、insert (altar-team-api) |  |
| `altar_team_rules` | delete、insert、update | delete、insert、update (altar-team-api) |  |
| `altar_team_swaps` | insert | insert、update (altar-team-api) |  |
| `altars` | delete、insert、update | — | 只有 Dashboard 能寫 |
| `calendar_entries` | delete、insert、update、upsert | — | 只有 Dashboard 能寫 |
| `car_manager_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `car_trips` | delete、update | delete、insert、update (carpool-api) |  |
| `csv_export_templates` | delete、upsert | — | 只有 Dashboard 能寫 |
| `driver_profiles` | — | upsert (carpool-api) | 只有 LIFF 能寫 |
| `event_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `event_groups` | delete、insert | delete、insert (events-admin-api) |  |
| `events` | delete、insert、update | delete、insert、update (events-admin-api) |  |
| `family_members` | — | delete、insert、update (profile-api) | 只有 LIFF 能寫 |
| `group_systems` | delete、insert | — | 只有 Dashboard 能寫 |
| `host_profiles` | — | upsert (lodging-api) | 只有 LIFF 能寫 |
| `kitchen_menu_items` | — | delete、insert (kitchen-api) | 只有 LIFF 能寫 |
| `kitchen_menus` | — | delete、insert、update (kitchen-api) | 只有 LIFF 能寫 |
| `kitchen_recipes` | — | delete、insert、update (kitchen-api) | 只有 LIFF 能寫 |
| `kitchen_tasks` | — | delete、insert、update (kitchen-api) | 只有 LIFF 能寫 |
| `liff_apps` | — | upsert (create-liff-app) | 只有 LIFF 能寫 |
| `lodging_manager_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `lodging_offers` | delete、update | delete、insert、update (lodging-api) |  |
| `lodging_requests` | delete、update | delete、insert、update (lodging-api) |  |
| `meeting_action_items` | — | delete、insert、update (meeting-api) | 只有 LIFF 能寫 |
| `meeting_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `meeting_attendance` | — | update (meeting-api) | 只有 LIFF 能寫 |
| `meeting_instances` | — | update (meeting-api) | 只有 LIFF 能寫 |
| `meeting_types` | — | delete、insert、update (meeting-api) | 只有 LIFF 能寫 |
| `registrations` | delete、update | delete、insert、update (events-admin-api, registrant-api) |  |
| `ride_requests` | delete、update | delete、insert、update (carpool-api) |  |
| `task_assignments` | insert、update | insert、update (tasks-api) |  |
| `task_group_members` | delete、insert | delete、insert (altar-team-api) |  |
| `task_groups` | delete、insert、update | — | 只有 Dashboard 能寫 |
| `task_instances` | — | — | 兩邊都只讀 |
| `task_job_admins` | delete、insert | — | 只有 Dashboard 能寫 |
| `task_job_presets` | delete、insert、update | delete、upsert (tasks-admin-api) |  |
| `task_subtask_completions` | delete、insert、update | delete、insert、update (tasks-admin-api, tasks-api) |  |
| `task_subtask_templates` | delete、insert、update | delete、insert、update (tasks-admin-api) |  |
| `task_template_groups` | delete、insert | delete、insert (tasks-admin-api) |  |
| `task_templates` | delete、insert、update | delete、insert、update (tasks-admin-api) |  |
| `train_schedule` | delete、insert、upsert | — | 只有 Dashboard 能寫 |
| `user_profiles` | — | upsert (profile-api) | 只有 LIFF 能寫 |
| `users` | — | delete、update、upsert (altar-team-api, carpool-api, events-admin-api, flow-admin-api, home-api, kitchen-api, lodging-api, meeting-api, profile-api, registrant-api, tasks-admin-api, tasks-api) | 只有 LIFF 能寫 |

_產生時間：2026-10-09_
