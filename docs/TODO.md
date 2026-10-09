# TODO：多租戶 SaaS 轉換

目前系統是單租戶（只服務一間宮廟），資料庫、前端都寫死對應這一間的設定。這份清單記錄
「之後要把它改成可以賣給多個宮廟/組織的 SaaS」需要做的事。討論記錄見 [DECISIONS.md](DECISIONS.md)。

**現在的狀態**：功能還在快速變動中（幾乎每天都有新 zip 更新），先不要動手做下面任何一項。
等功能明顯穩定下來、新功能頻率降低後，才開始第 1 步。

## 第 0 步（現在進行中）：盤點 Common vs 宮廟特有

把現有功能/資料分成兩類：

- **Common（通用）**：報名、任務管理、行事曆、膳宿交通——所有宮廟/組織大概都會需要的東西
- **宮廟特有**：仙佛紀念日名稱、叩首、祭壇團隊輪值邏輯——這間宮廟自己的宗教慣例

> 目前正在新增的功能先以 Common 為主。等這份盤點做完，才知道哪些東西要變成
> tenant 可自訂的設定（存進 `tenants.branding` jsonb），哪些維持寫死在程式碼裡即可
> （因為所有客戶都一樣）。

- [ ] 列出目前所有表（`users`、`calendar_entries`、`task_templates`、altar team 相關表…），標記 Common / 宮廟特有
- [ ] 列出前端寫死的內容（如 `CAL_KIND` 對照表、神祇名稱、團隊名稱），標記 Common / 宮廟特有

## 第 1 步：決定 tenant 識別機制

- [ ] 確認商業模式：每個客戶是否都有自己獨立的 LINE Official Account / LIFF ID？
      （目前設計假設是——用 `liff_id → tenant_id` 查表來判斷請求屬於哪個租戶）
- [ ] Edge Function 加一層「解析 tenant_id」的共用邏輯，所有 function 最前面都要過這一關

## 第 2 步：資料庫 schema 改動

採用「同一 DB、`tenant_id` 欄位 + RLS」策略（相對於 schema-per-tenant，因為預期客戶數會持續成長，這個方案單位成本較低）。

- [ ] 新增 `tenants` 表：`id, name, slug, line_channel_id, liff_id, plan, status, branding jsonb, created_at`
- [ ] 每張既有表加 `tenant_id uuid not null references tenants(id)`（直接疊加在每張表上，不要只放 `users` 再靠 join 推導）
- [ ] 改寫唯一鍵：`users` 的 `unique(line_user_id)` → `unique(tenant_id, line_user_id)`（見 [profile-api/index.ts:94](../supabase/functions/profile-api/index.ts#L94)）
- [ ] 盤點所有現有 unique/index，確認是否都要補上 `tenant_id`

## 第 3 步：權限（RLS）

- [ ] 每張表開 RLS policy，用 `tenant_id = 當前使用者的 tenant_id` 當條件
- [ ] 在 Supabase Auth JWT 裡塞自訂 claim `tenant_id`，RLS policy 用 `auth.jwt()` 讀取比對
- [ ] 現有 admin/審核者角色（`admin-roles-api` 等）補上 `tenant_id`，避免 A 宮廟管理員自動變成 B 宮廟管理員
- [ ] 設計平台方（你自己）的跨租戶「超級管理員」身分，範圍要盡量小，避免變成繞過隔離的後門

## 第 4 步：品牌/設定可配置化

- [ ] 把寫死在程式碼裡的宮廟特有內容（神祇名稱、紀念日、團隊結構標籤）改成從 `tenants.branding` jsonb 讀取
- [ ] 前端 Supabase URL/Key 從寫死（見 [event-registration/index.html:333](../index.html#L333)）改成依 tenant 動態載入

## 第 5 步：既有資料遷移

- [ ] 新增一筆 `tenants` 記錄代表現在這間宮廟（tenant #1）
- [ ] 把每張現有表的每一列都補上這個 `tenant_id`
- [ ] 欄位改成 `not null`，補上新的 unique 限制
- [ ] **先在測試環境演練一次完整流程**，確認無誤才對正式環境執行（一次性、不可逆）

## 懸而未決的問題

- 每個客戶是否一定有自己獨立的 LINE OA？如果有客戶想共用一個 OA，tenant 識別機制要重新設計
- 要不要在正式開放給其他宮廟前，先找 1-2 間潛在客戶訪談需求，驗證「Common 功能」的盤點是否正確
