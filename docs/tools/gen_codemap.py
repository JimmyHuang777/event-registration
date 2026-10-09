#!/usr/bin/env python3
"""產生 docs/CODEMAP.md（程式地圖）。只用標準函式庫。

用法（在 event-registration repo 根目錄）：
    python3 docs/tools/gen_codemap.py [--dashboard 路徑/Dashboard/index.html]

不給 --dashboard 時會嘗試 ../Dashboard/index.html。
每次改程式後重新執行，和程式一起提交。內容是用正規表示式掃出來的「近似地圖」：
動作（action）與資料表是依 `case "xxx":` 區塊與 `.from("xxx")` 比對，
區塊外的共用函式所用的表不會算進去。
"""
import re, sys, os, glob, datetime

ROOT = os.getcwd()
args = sys.argv[1:]
dash = None
if '--dashboard' in args:
    dash = args[args.index('--dashboard') + 1]
else:
    cand = os.path.join(ROOT, '..', 'Dashboard', 'index.html')
    if os.path.exists(cand): dash = cand

def read(p):
    with open(p, encoding='utf-8') as f: return f.read()

def uniq(seq):
    seen = set(); out = []
    for x in seq:
        if x not in seen: seen.add(x); out.append(x)
    return out

out = []
w = out.append
w('# 程式地圖（CODEMAP）')
w('')
w('> 由 `docs/tools/gen_codemap.py` 自動產生，請勿手改。內容為掃描程式得到的近似地圖。')
w('> 查「某功能改哪裡」時先看這份：頁面 → 用到哪個函式／動作 → 讀寫哪些表 → Dashboard 哪個區段。')
w('')

# ---------- Edge Functions ----------
fn_dir = os.path.join(ROOT, 'supabase', 'functions')
fns = sorted(d for d in os.listdir(fn_dir) if os.path.exists(os.path.join(fn_dir, d, 'index.ts')))
fn_tables = {}
w('## 1. Edge Function（動作與資料表）')
w('')
for fn in fns:
    src = read(os.path.join(fn_dir, fn, 'index.ts'))
    cases = [(m.start(), m.group(1) or m.group(2)) for m in re.finditer(r'case\s+["\']([a-z_0-9]+)["\']\s*:|action\s*===?\s*["\']([a-z_0-9]+)["\']', src)]
    all_tables = uniq(re.findall(r'\.from\(\s*["\']([a-z_0-9]+)["\']', src))
    fn_tables[fn] = all_tables
    w(f'### {fn}')
    w('')
    w('- 資料表（整個函式）：' + (', '.join(f'`{t}`' for t in all_tables) or '—'))
    if cases:
        w('')
        w('| 動作 | 直接用到的資料表 |')
        w('|---|---|')
        for i, (pos, name) in enumerate(cases):
            end = cases[i + 1][0] if i + 1 < len(cases) else len(src)
            tabs = uniq(re.findall(r'\.from\(\s*["\']([a-z_0-9]+)["\']', src[pos:end]))
            w(f'| `{name}` | ' + (', '.join(f'`{t}`' for t in tabs) or '（呼叫共用函式）') + ' |')
    w('')

# ---------- LIFF pages ----------
w('## 2. LIFF 頁面 → 函式與動作')
w('')
w('| 頁面 | 標題 | 呼叫的 Edge Function | 呼叫的動作 |')
w('|---|---|---|---|')
for p in sorted(glob.glob(os.path.join(ROOT, '*.html'))):
    src = read(p)
    base = os.path.basename(p)
    t = re.search(r'<title>([^<]*)', src)
    used = uniq(re.findall(r'functions\.supabase\.co/([a-z0-9-]+)', src))
    acts = uniq(re.findall(r'call[A-Za-z]*Api\(\s*["\']([a-z_0-9]+)["\']', src))
    if not used and not acts: continue
    w(f'| {base} | {t.group(1).strip() if t else ""} | ' + (', '.join(f'`{u}`' for u in used) or '—') + ' | ' + (', '.join(f'`{a}`' for a in acts) or '—') + ' |')
w('')

# ---------- Table -> who touches it ----------
w('## 3. 資料表 → 哪些 Edge Function 會用')
w('')
rev = {}
for fn, tabs in fn_tables.items():
    for t in tabs: rev.setdefault(t, []).append(fn)
w('| 資料表 | Edge Function |')
w('|---|---|')
for t in sorted(rev): w(f'| `{t}` | ' + ', '.join(f'`{x}`' for x in rev[t]) + ' |')
w('')

# ---------- SQL ----------
sql_dir = os.path.join(ROOT, 'SQL')
if os.path.isdir(sql_dir):
    w('## 4. SQL 檔與其建立／修改的表')
    w('')
    w('| 檔案 | 動到的資料表 |')
    w('|---|---|')
    for p in sorted(glob.glob(os.path.join(sql_dir, '*.sql'))):
        s = read(p)
        tabs = [t for t in uniq(re.findall(r'(?:create table(?: if not exists)?|alter table(?: if exists)?|create policy[^;]*? on|insert into)\s+(?:public\.)?"?([a-z_0-9]+)', s, re.I)) if t not in ('public', 'if', 'not', 'exists')]
        w(f'| {os.path.basename(p)} | ' + (', '.join(f'`{t}`' for t in tabs) or '—') + ' |')
    w('')

# ---------- Dashboard ----------
if dash and os.path.exists(dash):
    d = read(dash)
    lines = d.split('\n')
    w('## 5. Dashboard（index.html）')
    w('')
    w(f'- 總行數：{len(lines)}')
    w('- 區段（行號）：')
    w('')
    marks = [(i + 1, re.match(r'/\* -+ (.*)', l).group(1).rstrip(' -*/').strip()) for i, l in enumerate(lines) if re.match(r'/\* -{5,} ', l)]
    w('| 起始行 | 結束行 | 區段 |')
    w('|---|---|---|')
    for i, (ln, name) in enumerate(marks):
        end = marks[i + 1][0] - 1 if i + 1 < len(marks) else len(lines)
        w(f'| {ln} | {end} | {name} |')
    w('')
    btns = re.findall(r'<button[^>]*id="(manage-[a-z-]+-btn|new-[a-z-]+-btn)"[^>]*>\s*([^<]{1,30})', d)
    if btns:
        w('- 頂部入口按鈕：' + '、'.join(f'`{i}`（{t.strip()}）' for i, t in btns))
        w('')
    tabs = uniq(re.findall(r'supabaseClient\s*\.from\(\s*["\']([a-z_0-9]+)["\']', d))
    w('- Dashboard 直接讀寫的資料表（走 Supabase RLS）：' + ', '.join(f'`{t}`' for t in tabs))
    w('')
    edges = uniq(re.findall(r'functions\.supabase\.co/([a-z0-9-]+)', d))
    w('- Dashboard 呼叫的 Edge Function：' + (', '.join(f'`{e}`' for e in edges) or '—'))
    w('')
    libs = uniq(re.findall(r'https://(?:cdnjs\.cloudflare\.com/ajax/libs|cdn\.jsdelivr\.net/npm|unpkg\.com)/([^\s"\']+)', d))
    w('- 外部程式庫（CDN）：' + ', '.join(f'`{l}`' for l in libs))
    w('')


# ---------- Parity matrix (write capability by table) ----------
def _ops(src):
    import collections
    d = collections.defaultdict(set)
    for m in re.finditer(r'\.from\(\s*["\']([a-z_0-9]+)["\']\s*\)', src):
        t = m.group(1); tail = src[m.end():m.end() + 260]
        mm = re.match(r'\s*\.\s*(select|insert|update|upsert|delete)\b', tail)
        if mm: d[t].add(mm.group(1))
        else:
            mm = re.search(r'\.\s*(insert|update|upsert|delete)\b', tail[:120])
            d[t].add(mm.group(1) if mm else 'select')
    return d
if dash and os.path.exists(dash):
    import collections
    dops = _ops(read(dash))
    lops = collections.defaultdict(lambda: collections.defaultdict(set))
    for fn in fns:
        for t, o in _ops(read(os.path.join(fn_dir, fn, 'index.ts'))).items(): lops[t][fn] |= o
    w('## 6. 手機（LIFF）與 Dashboard 的資料表寫入能力對照')
    w('')
    w('> 依程式掃描：Dashboard 直接寫入（走 RLS）、LIFF 經 Edge Function 寫入。**只有一邊能寫的表**是兩邊功能差異的線索，請對照 PARITY.md 的說明。')
    w('> 掃描限制：用變數當表名的寫入（例如 `tasks-admin-api` 的 `perms_set` 透過 `PERM_TABLES` 寫入 event_admins、task_job_admins、car_manager_admins、lodging_manager_admins、meeting_admins、activity_flow_admins）掃不到；Dashboard 經 Edge Function 寫入的（admin_roles、liff_apps）也會顯示在 LIFF 那欄。')
    w('')
    w('| 資料表 | Dashboard 寫入 | LIFF 寫入（函式） | 差異 |')
    w('|---|---|---|---|')
    for t in sorted(set(dops) | set(lops)):
        dw = sorted(dops.get(t, set()) - {'select'})
        lw = sorted(set().union(*[o - {'select'} for o in lops[t].values()]) if t in lops else [])
        lf = [fn for fn, o in lops.get(t, {}).items() if o - {'select'}]
        flag = ''
        if dw and not lw: flag = '只有 Dashboard 能寫'
        elif lw and not dw: flag = '只有 LIFF 能寫'
        elif not dw and not lw: flag = '兩邊都只讀'
        w(f'| `{t}` | ' + ('、'.join(dw) or '—') + ' | ' + ('、'.join(lw) or '—') + (' (' + ', '.join(lf) + ')' if lf else '') + f' | {flag} |')
    w('')

w(f'_產生時間：{datetime.date.today().isoformat()}_')
os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
with open(os.path.join(ROOT, 'docs', 'CODEMAP.md'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(out) + '\n')
print('docs/CODEMAP.md 已產生，', len(out), '行')
