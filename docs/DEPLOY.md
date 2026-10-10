# 部署與 SQL 清單

> SQL 檔現在放在 repo 根目錄的 `SQL/`（之前 repo 內沒有，只在交付 zip 裡），之後一律進版控。41–44 號不在手上，若有請補進 `SQL/`。

## 部署流程
- **LIFF 頁面／Edge Function**：`git push` 到 `main`，GitHub Actions（`.github/workflows/deploy-edge-function.yml`）自動部署有變動的 Edge Function（`--no-verify-jwt`）。
- **Dashboard**：推送 `Dashboard` repo 的 `index.html`。
- **SQL**：人工在 Supabase SQL Editor 執行，**先跑 SQL，再推程式**（程式會用到新欄位／新表）。
- 推送前：`git diff` 確認變動範圍。

## 新增 Edge Function 的步驟
1. 建 `supabase/functions/<name>/index.ts`
2. 在 workflow 的 `paths:` 加 `supabase/functions/<name>/**`
3. 在 workflow 加對應的 Deploy step（`supabase functions deploy <name> --project-ref ixzvbyxhzttvnheivsoc --no-verify-jwt`）

## 目前的 Edge Function
admin-roles-api、altar-team-api、calendar-api、carpool-api、create-liff-app、dispatch-run、events-admin-api、flow-admin-api、flow-api、home-api、kitchen-api、lodging-api、meeting-api、profile-api、registrant-api、tasks-admin-api、tasks-api

## SQL 清單（依編號）
「已執行」欄請在 Supabase 確認後自行勾選維護。

| 編號 | 檔名 | 用途 | 已執行 |
|---|---|---|---|
| 39 | single-liff-cleanup | 單一 LIFF 整合後的清理 | ☐ |
| 40 | personal-profile | 個人資訊／親友資訊（user_profiles、family_members） | ☐ |
| 45 | subtask-slots | 子任務名額 | ☐ |
| 46 | csv-export-templates | CSV／PDF／Excel 匯出範本（csv_export_templates） | ☐ |
| 47 | calendar-entries | 行事曆（calendar_entries） | ☐ |
| 48 | allow-duplicate-registration | 允許重複報名 | ☐ |
| 49 | duplicate-check-by-name | 重複報名改以姓名比對 | ☐ |
| 50 | calendar-saint-days | 仙佛紀念日（calendar_entries 擴充） | ☐ |
| 51 | train-schedule | 火車時刻（train_schedule） | ☐ |
| 52 | saint-days-fields | 仙佛紀念日欄位（含 saint_name） | ☐ |
| 53 | altar-manager-teams | 壇管理者所屬組別（altar_manager_teams） | ☐ |
| 54 | review-leader-job-admins | 組長／工作管理者審核 | ☐ |
| 55 | subtask-checklist-fields | 子任務的時間／地點／負責人／檢核人欄位 | ☐ |
| 56 | altar-team-rules-handover-swaps | 各組工作細則（6W）、交接項目、整組對調 | ☐ |
| 58 | train-timetable-ruisui | 瑞穗站完整時刻（去程 28 班、回程 28 班；第三方資料，需核對） | ☐ |
| 57 | train-direction | 火車時刻分去程（south）／回程（north）；arrive_time 改可空 | ☐ |

> 41–44 號在本文件建立時未列入清單，若有請補上。
