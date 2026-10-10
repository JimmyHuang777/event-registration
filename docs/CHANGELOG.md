# 變更紀錄

版本號用 `YYYY.MM.DD-n`。每筆註明：影響範圍（📱LIFF／🖥Dashboard／⚙Edge Function）、**要跑的 SQL**、**要部署的項目**。
本檔以「本輪開發」整理既有紀錄；之後每次 push 前在最上方新增一段。

## [未發佈]
（新的變更先寫這裡）

## 2026.10.11-3　收緊權限（SQL 62）
- 🗄 **報到人員只能改報名狀態**：`registrations` 加觸發器，staff 不能改姓名、電話、欄位內容、所屬活動或報名人；主辦、超級管理者、Edge Function、SQL Editor 不受影響。
- 🗄 **匯出範本**：所有管理者仍可讀取與新增；修改與刪除限超級管理者或建立者（新增 `created_by`）。既有範本的建立者是空的，所以只有超級管理者能改／刪。
- **要先跑的 SQL**：`SQL/62-tighten-staff-and-csv-policies.sql`（可重複執行，檔尾有還原方式）。**無程式碼變更，不需要 push**。已在本機 Postgres 以模擬角色測過。

## 2026.10.11-2　報名截止日
- 📱🖥⚙ 活動新增「報名截止」（`events.registration_deadline`，台灣時間輸入與顯示，空白＝不限）。Dashboard 新增／編輯活動、手機 `event-admin.html` 都能設定；報名頁（`index.html`）顯示截止時間，截止後隱藏報名表；`registrant-api` 截止後拒絕新增報名與修改（**仍可取消**）。
- ⚙ 自動派工複製範本活動時，沿用範本「截止日離活動日幾天」；若算出的時間已過則不設截止。
- **要先跑的 SQL**：`SQL/60-registration-deadline.sql`。**必須先跑再 push**，否則報名頁會因為查不到新欄位而打不開。部署：Dashboard `index.html`、`index.html`、`event-admin.html`、`registrant-api`、`events-admin-api`、`dispatch-run`。
- 📄 權限審查：已對照實際 RLS 清單（`pg_policies`），見 DECISIONS D-20261011-01。

## 2026.10.11-1　安全與穩定性修補（審查後）
- 🖥 **報名名單分頁讀取**：Dashboard 報名者名單與其後的匯出，不再被 1000 筆上限截斷。背景徽章輪詢在頁面不可見時暫停。
- ⚙ **認領名額防超收**：`claim_task`、`claim_subtask` 寫入後再核對名額，超出者自動撤銷並回「已額滿」。
- ⚙ **報名檢查**：`registrant-api` 活動未啟用時不能報名／修改；單次最多 20 人；姓名 100、電話 40、備註 1000 字、`extra_data` 8000 字上限。
- ⚙ **錯誤訊息**：所有 Edge Function 的 500 錯誤改回通用訊息，細節只寫進伺服器日誌；`dispatch-run` 密鑰改固定時間比較。
- **覆蓋規則維持不變**（D-20261010-05）。**無 SQL**。部署：Dashboard `index.html`＋13 個 Edge Function（含 `dispatch-run`）。

## 2026.10.10-4
- 🖥⚙ **自動派工**：新增 Dashboard「🤖 自動派工」與 Edge Function `dispatch-run`。依「派工規則」（行事曆標題關鍵字、指定行事曆項目、仙佛紀念日、農曆初一／十五），在來源日期前的「提前天數」內自動：複製範本活動建立報名表、依工作清單（`task_job_presets`）建立單次工作並指定群組、推送 LINE 給群組成員，並寫入 `dispatch_log`（每條規則＋來源只派一次）。每天台灣 06:00 由 GitHub Actions `dispatch-daily.yml` 呼叫；Dashboard 另有「預覽」「立即執行」。見 D-20261010-04。
- **要先跑的 SQL**：`SQL/59-auto-dispatch.sql`（`dispatch_rules`、`dispatch_log`）。
- **要部署／設定**：`dispatch-run`（已加入 `deploy-edge-function.yml`）、新增 `.github/workflows/dispatch-daily.yml`；**Supabase Edge Function secret 與 GitHub secret 都要新增 `DISPATCH_CRON_SECRET`（同一個隨機字串）**；`LINE_CHANNEL_ACCESS_TOKEN` 已有才會推送。
- 📄 PARITY 新增 P-10（規則管理只在 Dashboard，建議列為例外）。

## 2026.10.10-3
- 🖥 **P-09**：「新增／編輯活動」表單補上「提供交通（共乘）」「提供住宿」勾選框。
- 🖥 **P-01**：壇的詳細畫面（天廚組）新增「🍳 食譜／菜單／工作」管理（食譜、菜單、工作的新增／編輯／刪除、指派、完成）。
- 📱⚙ **P-03**：LIFF 行事曆讓活動管理者新增／編輯／刪除一般行程；`calendar-api` 新增 `save_entry`、`delete_entry`，`month` 回傳 `can_edit`。仙佛紀念日仍只在 Dashboard。
- 📄 PARITY：P-01、P-03、P-09 補齊；P-07、P-08 拿掉並列為例外。見 D-20261010-03。
- **無 SQL**。部署：Dashboard `index.html`、`calendar.html`、`calendar-api`（已在 workflow，無需改 workflow）。

## 2026.10.10-2
- 📱🖥⚙ **新增臨時會議**：沒有排定的會議也能直接新增一場並填寫紀錄、出席、待辦（日期可以是過去，用來補記錄）。做法＝建立「單次」會議類型＋當天場次，所以統計與 LINE 頁面照常運作。`meeting-api` 新增 `create_adhoc_meeting`。見 D-20261010-02。無 SQL。部署：Dashboard `index.html`、`meetings.html`、`meeting-api`。

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
