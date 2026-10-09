# 文件索引

這個資料夾是系統的「功能文件」，和程式碼一起用 git 管理，版本紀錄就是 git 歷史。

| 檔案 | 內容 | 何時更新 |
|---|---|---|
| [FEATURES.md](FEATURES.md) | 每個功能的用途、所在頁面、手機／Dashboard 對照 | 新增、修改、移除功能時 |
| [DECISIONS.md](DECISIONS.md) | 討論過的決議與原因（為什麼這樣做、哪些刻意不做） | 每次討論出結論時 |
| [CHANGELOG.md](CHANGELOG.md) | 依時間記錄每次變更（含要跑的 SQL、要部署的函式） | 每次 push 前 |
| [PARITY.md](PARITY.md) | **手機（LIFF）與 Dashboard 的差異對照**：待決定／刻意不同／形式不同 | 新增或修改功能時 |
| [CODEMAP.md](CODEMAP.md) | **自動產生**的程式地圖：頁面→函式／動作→資料表、Dashboard 區段行號 | 每次改程式後執行 `python3 docs/tools/gen_codemap.py --dashboard ../Dashboard/index.html` |
| [DEPLOY.md](DEPLOY.md) | 部署流程、SQL 執行清單與順序、檢查清單 | 新增 SQL／函式時 |

## 維護規則

1. **改程式就改文件**：同一個 commit 一起更新 FEATURES／CHANGELOG（有決議再加 DECISIONS）。
2. **commit 訊息**建議格式：`類型: 簡述`，類型為 feat／fix／docs／sql／chore。
3. **版本號**：用日期版 `YYYY.MM.DD-n`（同一天第 n 次發佈），寫在 CHANGELOG 標題；需要時用 git tag 標記，例如 `git tag v2026.10.09-1`。
4. **SQL 檔**編號遞增、不改舊檔；要修正就新增一個編號。
5. **新增或改名 Edge Function**：同時更新 `.github/workflows/deploy-edge-function.yml`。
6. **手機／Dashboard 對照**：每個功能在 FEATURES.md 的「對照」欄註明兩邊是否都有；只在一邊的要寫明原因（例外清單見 FEATURES.md 最後一節）。
7. **查資料的順序**：先看 CODEMAP（該改哪裡）→ DECISIONS（當時為何這樣決定）→ FEATURES（功能現況），最後才讀程式碼。
8. 推送前先跑 `git diff` 確認只有預期的檔案有變動。

## 系統組成

- **LIFF 頁面**（本 repo 根目錄 `*.html`）：LINE 內開啟，經 `callApi(action, extra)` 帶 LINE idToken 呼叫 Supabase Edge Function。
- **Edge Functions**（`supabase/functions/*`）：用 service role 存取資料庫，各自驗證 LINE idToken，部署時一律 `--no-verify-jwt`。
- **Dashboard**（另一個 repo `Dashboard`，單一 `index.html`）：用 Supabase Auth 登入，靠 RLS（`is_super_admin()` 等）存取資料。
- **資料庫**：Supabase Postgres，結構變更放在 repo 根目錄 `SQL/NN-*.sql`，由人工在 SQL Editor 執行。
