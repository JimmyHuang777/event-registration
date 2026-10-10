# 變更紀錄

版本號用 `YYYY.MM.DD-n`。每筆註明：影響範圍（📱LIFF／🖥Dashboard／⚙Edge Function）、**要跑的 SQL**、**要部署的項目**。
本檔以「本輪開發」整理既有紀錄；之後每次 push 前在最上方新增一段。

## [未發佈]
（新的變更先寫這裡）

## 2026.10.10-1
- 🖥 Dashboard「溝通共識系統」從只有管理員名單，擴充為完整會議管理：**會議類型**（新增／編輯／刪除）、**場次**（日期區間、類型、狀態篩選；標記出席、紀錄、狀態、待辦事項）、**待辦事項總覽**（所有人，可依狀態／負責人／會議／日期篩選，勾選完成、刪除）、**統計**（依會議類型與個人的出席率、待辦完成率）與**匯出 Excel／出席明細 CSV**。見 D-20261010-01。
- 📱⚙ LIFF `meetings.html` 與 `meeting-api`：新增**待辦事項總覽**（`list_all_action_items`）、**統計**（`meeting_stats`），場次畫面可切換**過去 30／90／180 天**；`list_upcoming_instances` 改用巢狀查詢，避免出席人數被 1000 筆上限截斷，並限制區間最多 400 天。
- **無 SQL**（沿用 SQL 32 的資料表與「超級管理者可直接讀寫」的 RLS）。
- 部署：Dashboard `index.html`、`meetings.html`、`meeting-api`（已在 workflow，無需改 workflow）。

## 2026.10.09-5
- 🖥 火車時刻的時間欄改為 24 小時制文字輸入（HH:MM，也接受 0805），修正瀏覽器時間控制項顯示「上午 04:」被截斷。

## 2026.10.09-4
- 瑞穗站完整時刻（去程 28 班、回程 28 班）：**SQL 58**（需先執行 57）。見 D-20261009-10。無程式變更。

## 2026.10.09-3
- 🖥📱⚙ 火車時刻分去程（南下，顯示抵達瑞穗時間）與回程（北上，顯示瑞穗出發時間）兩頁；報名欄位「火車車次」新增去程／回程選項。見 D-20261009-09。
- **SQL：57**（先跑）。部署：Dashboard `index.html`、`event-admin.html`、`events-admin-api`（已在 workflow，無需改 workflow）。

## 2026.10.09-2
- 🖥 匯出改為「交通、住宿、用餐統計表」：欄位由報名欄位決定（火車抵達／離站、內宿／外宿、用餐），匯入範本只讀序號列以上；移除舊的開班參加名單格式與公式匯入。見 D-20261009-08。
- 📱🖥 活動欄位建立器：欄位名稱輸入「住宿」自動帶入選項「內宿,外宿」。
- 無 SQL（使用既有 `train_schedule.depart_time`）。部署：Dashboard `index.html`、`event-admin.html`。

## 2026.10.09（含本次未推送的修改）
- 🖥 開班參加名單 Excel：配合 1018 範本，天職欄位（點傳師、壇主、副壇主、講師、辦事人員、道親、班員、補課、旁聽、小天使）視為格式欄位；匯入範本不再當自訂欄位。
- 🖥 自動排序改為兩種：依性別及天職（預設）、依報名時間；天職順序新增班員、補課、旁聽。
- 🖥 匯入範本帶入所有有值儲存格與公式（表頭區、資料列公式、表格右側）；合併儲存格只取左上角。
- 🖥 移除匯出視窗的「加入天職欄位」勾選框。
- 文件：新增 docs/ 與 SQL/。無新 SQL。

## 以下為 GitHub 提交歷史（自動整理，日期為提交日；📱＝event-registration，🖥＝Dashboard）

### 2026-10-09
- 🖥 Update roster export in dashboard
- 🖥 Update roster export in dashboard
- 🖥 Update roster export in dashboard
- 🖥 Add roster export and saint save fix to dashboard

### 2026-10-08
- 📱 Add altar team feature API
- 📱 Add altar calendar support
- 🖥 Add altar team dashboard features
- 🖥 Update altar calendar dashboard

### 2026-10-07
- 📱 Add checklist templates for subtasks across tasks pages
- 📱 Add lunar 1/15 calendar handling and registration eligibility checks
- 📱 Add leader-scoped task administration
- 📱 Add altar leader/team management to events admin
- 🖥 Add checklist templates for subtasks
- 🖥 Add lunar 1/15 handling to dashboard calendar
- 🖥 Add PDF export to dashboard
- 🖥 Apply saint-import-fix and altar-leader-events updates to dashboard

### 2026-10-06
- 📱 Load train schedules in event admin
- 📱 Preserve custom field IDs
- 📱 Handle duplicate attendee registrations with confirmation
- 📱 Prevent duplicate attendee registrations
- 📱 Add saint-days support to calendar page and calendar API
- 🖥 Add saint day lunar calendar management
- 🖥 Add train schedule management
- 🖥 Preserve field IDs and export archived answers
- 🖥 Remove obsolete standalone LIFF links
- 🖥 Update dashboard for saint-days calendar feature

### 2026-10-05
- 📱 Remove phone fields from member workflows
- 📱 Add train options to event forms
- 📱 Improve calendar filters and duplicate registration handling
- 📱 Add shared calendar and calendar API
- 🖥 Remove phone fields from Dashboard workflows
- 🖥 Improve Word import detection and train fields
- 🖥 Add work rules import and registration bulk actions
- 🖥 Add calendar filters and duplicate registration controls
- 🖥 Add calendar management and CSV export tools

### 2026-10-02
- 📱 Add altar-aware events and profile prefills
- 📱 Support multiple assignees per subtask
- 📱 Add admin task assignment workflow
- 📱 Add admin roles edge function
- 📱 Improve task section visibility
- 📱 Add altar and transport settings
- 📱 Add featured programs to Home
- 📱 Add sections to task subtasks
- 🖥 Display multi-assignee subtasks
- 🖥 Add admin role management controls
- 🖥 Improve subtask section styling
- 🖥 Add altar and member profile administration
- 🖥 Add featured program controls

### 2026-09-30
- 📱 Require complete personal registration details
- 📱 Allow manual edge function deployments
- 📱 Deploy profile API edge function
- 📱 Initialize shared LIFF before home redirect
- 📱 Improve profile navigation and LIFF startup
- 📱 Add personal and family profile management
- 📱 Consolidate LIFF entry points
- 📱 Preserve titles for non-event LIFF pages
- 🖥 Update Home branding and default event fields
- 🖥 Use shared Home LIFF entry point

### 2026-09-29
- 📱 Support shared event LIFF state
- 📱 Use shared LIFF apps for event and altar links
- 📱 Update task and flow labels
- 🖥 Add LIFF link regeneration controls
- 🖥 Include entity parameters in LIFF links
- 🖥 Add task assignment dashboard views

### 2026-09-23
- 📱 Add resident altar team support
- 📱 Add hierarchical altar visibility
- 📱 Add altar links and scope task groups
- 🖥 Add resident team and system management
- 🖥 Make index.html the single Dashboard entry point

### 2026-09-22
- 📱 Add altar hub and scoped altar team tasks
- 📱 Add kitchen-api Edge Function and kitchen.html LIFF page
- 📱 Add meeting-api Edge Function and meetings.html LIFF page for 溝通共識系統
- 🖥 Add per-altar LIFF links and team task sync
- 🖥 Add per-altar LIFF links and team task sync
- 🖥 Sync index.html with admin-dashboard.html (missed in last 2 updates)
- 🖥 Update admin dashboard system hierarchy and kitchen management
- 🖥 Add Meetings panel and System/Group hierarchy to admin dashboard

### 2026-09-21
- 📱 add message aip
- 📱 add one time task
- 🖥 support message api

### 2026-09-20
- 📱 Rename lodging role/screen labels
- 📱 Add offers_transport/offers_lodging event flags and full Lodging feature
- 📱 Carpool v5: start/end time in 5-min steps, waiting-location rename, driver-updatable location
- 📱 Carpool v4: passenger self-closes a finished ride, freeing the driver without manager involvement
- 📱 Carpool v3: driver/passenger contact info, multi-passenger requests, destination, extended trip status
- 📱 Redesign carpool as standalone Driver/Passenger/Car Manager LIFF app
- 🖥 Add event service toggles + Lodging management panel
- 🖥 Carpool v5: show waiting location + time range in matching modal
- 🖥 Carpool v3: dashboard matching modal for new fields/status
- 🖥 Add Carpool panel: LIFF link, Car Managers list, per-event matching

### 2026-09-19
- 📱 Scope the delete-my-data button to the current event only
- 📱 Add group visibility to events
- 📱 Add Event Admin LIFF page and list events on the Home entry page
- 📱 Add home entry LIFF page showing links by role/group
- 📱 Add flow presets feature
- 🖥 Add group checkboxes to New Event form
- 🖥 Add Event Admins management to Manage Events panel
- 🖥 Add Home Link management modal

### 2026-09-18
- 📱 minor change for the naming
- 📱 Fix flow item ordering and switch time fields to plain text input
- 📱 Update deploy workflow to include flow-api and flow-admin-api Edge Functions
- 📱 Support creating activity flow
- 📱 Change naming
- 📱 Add blank in tasks-admin-api
- 📱 Add tasks-admin-api deployment to workflow
- 📱 Add tasks-admin-api and tasks-admin.html: mobile job management via LIFF
- 📱 Fix 今日組內任務 using UTC date instead of local date
- 📱 Subtask-only claiming with unassigned/taken/completed/incomplete status
- 🖥 Support templete while creating the activity
- 🖥 minor change for the naming
- 🖥 minor fix for creating item on activity
- 🖥 Support activity flow
- 🖥 Add Job Admins management and job-admin LIFF link
- 🖥 Add job presets: save/apply job content excluding recurrence, day settings, and slots
- 🖥 Task stats/cards reflect subtask status instead of job-level assignments

### 2026-09-17
- 📱 Replace task tabs with unassigned/mine/week views; allow direct subtask claiming
- 📱 Add group-based visibility filtering to task list
- 📱 Fix ambiguous users relationship in task_subtask_completions query
- 📱 Add subtask claiming, task completion/confirmation workflow, wider task window
- 📱 Deploy edge functions with --no-verify-jwt to prevent gateway JWT lockout
- 📱 Auto-generate the tasks page LIFF link, like events
- 📱 Add task roster feature (tasks-api + tasks.html)
- 📱 Add GitHub Actions workflow to auto-deploy the Edge Function
- 📱 Support multi-attendee registration
- 📱 first commit
- 📱 first commit
- 📱 Initial commit: registration site with per-event meta tags
- 🖥 Add Groups management and template group assignment
- 🖥 Add task status stats tiles and confirm action
- 🖥 support a single task
- 🖥 Support multi-attendee registration
- 🖥 Support multi-attendee registration
- 🖥 Support multi-attendee registration
- 🖥 Admin dashboard: dynamic per-event fields, no email column
