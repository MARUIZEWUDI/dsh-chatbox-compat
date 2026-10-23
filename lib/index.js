/**
 * dsh-chatbox-compat — host half.
 *
 * Gives Chatbox converts the three things they miss in DeepSeek Harness:
 *   1. a visible, editable long-term memory (stored in MEMORY.md, injected each turn)
 *   2. a "mode" panel with real toggles (memory / skills / MCP)
 *   3. one-click compression of a conversation into a handoff briefing
 * Plus two small extras: live CPU/GPU temperature and a local SQLite knowledge base.
 *
 * Everything runs on one loopback port (default 43210, auto-bumps on conflict).
 * Env: DSH_HOME, DSH_COMPAT_PORT, DSH_KB_DIR.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as zlib from 'node:zlib'
import { createServer } from 'node:http'

export const name = 'chatbox-compat'
export const inject = ['tools', 'systemPrompt']

// ── paths & settings ─────────────────────────────────────────────────────

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(HOME, 'profiles', 'web')
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml')
const CRED_FILE = path.join(HOME, '.credentials.yaml')
const MEM_FILE = path.join(HOME, 'memory', 'MEMORY.md')
const SETTINGS_FILE = path.join(HOME, 'chatbox-compat', 'settings.json')
/** Pre-0.1 installs wrote settings under workmode/; keep reading that. */
const LEGACY_SETTINGS_FILE = path.join(HOME, 'workmode', 'settings.json')
const KB_DB = path.join(HOME, 'knowledge', 'kb.sqlite')
const DISABLED_SKILLS = path.join(HOME, 'disabled-skills')
const BACKUP_DIR = path.join(HOME, 'backups')

const DEFAULT_PORT = Number(process.env.DSH_COMPAT_PORT || 43210)
const HOST = '127.0.0.1'
const IS_WIN = process.platform === 'win32'

const KB_ROOT = process.env.DSH_KB_DIR || path.join(os.homedir(), 'kb')
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yml', '.yaml', '.log', '.cs', '.js', '.ts', '.mjs', '.cjs', '.ps1', '.html', '.css', '.xml', '.ini', '.gd', '.tres', '.tscn'])
const CHUNK = 1800
const MAX_FILES = 20000
const MAX_TRANSCRIPT = 220000

const DEFAULT_SETTINGS = { memoryEnabled: true, disabledSkills: [], disabledMcp: [] }

/** Chatbox's default handoff prompt, shipped as the textarea default. */
const DEFAULT_HANDOFF_PROMPT = `Summarize this conversation as a handoff briefing for an assistant that will continue it WITHOUT access to the full history. This is an out-of-character, meta-level request: do NOT continue the conversation or reply in character.

First determine what kind of conversation this is, then cover the matching sections with concrete detail:

If it is task-oriented (work, coding, analysis, research, tool use):
1. Goal & current state — what the user ultimately wants; what is done, in progress, or blocked right now
2. Key decisions and conclusions, and the reasons behind them
3. Facts learned from tool calls that are worth keeping — exact file paths, command outputs, data values, URLs, error messages
4. Files or artifacts created/modified, and what was changed in them
5. Next steps, in order

If it is role-play or creative writing (stories, characters, worldbuilding):
1. Premise, setting, and established world rules
2. Characters — names, roles, personality, speech style, and details established so far
3. Plot so far — key events and revelations, in order
4. Current scene — where things stand right now: location, ongoing action, emotional tone, relationship dynamics
5. Open threads — unresolved plot points, foreshadowing, and the user's stated preferences about direction and style

For general chat or mixed conversations, cover whichever of the above apply.

Preserve exact identifiers and established names verbatim (paths, code symbols, keys, numbers, character names). Skip sections that do not apply.
Write in 简体中文; if the conversation itself is mainly in a different language, use that language instead.
Be concise but complete. Do NOT include prefaces or meta-commentary.`

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

const safeStat = (p) => {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function readSettings() {
  for (const f of [SETTINGS_FILE, LEGACY_SETTINGS_FILE]) {
    try {
      const parsed = JSON.parse(readText(f))
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_SETTINGS, ...parsed }
    } catch {}
  }
  return { ...DEFAULT_SETTINGS }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

// ── long-term memory ─────────────────────────────────────────────────────

const MEM_HEADER = `# 长期记忆

> Maintained by dsh-chatbox-compat. One entry per block:
> \`## [Mxxx] YYYY-MM-DD · title\` followed by its body.
> The assistant edits this with memory_save / memory_delete / memory_search / memory_list.

`

function ensureMemory() {
  fs.mkdirSync(path.dirname(MEM_FILE), { recursive: true })
  if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, MEM_HEADER, 'utf8')
}

function parseMemory() {
  const lines = readText(MEM_FILE).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^##\s+\[(M\d{3,})\]\s*(.*)$/)
    if (m) {
      if (cur) out.push(cur)
      const parts = m[2].split('·')
      cur = { id: m[1], date: (parts[0] || '').trim(), title: (parts.slice(1).join('·') || '').trim(), body: [] }
      continue
    }
    if (cur) cur.body.push(line)
  }
  if (cur) out.push(cur)
  return out.map((e) => ({ ...e, text: e.body.join('\n').trim() }))
}

const nextMemoryId = (entries) => {
  let max = 0
  for (const e of entries) {
    const n = Number(e.id.slice(1))
    if (Number.isFinite(n) && n > max) max = n
  }
  return 'M' + String(max + 1).padStart(3, '0')
}

const todayStr = () => new Date().toISOString().slice(0, 10)
const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim()

function memoryInjection() {
  const entries = parseMemory()
  if (!entries.length) return '（暂无长期记忆）'
  if (readSettings().memoryEnabled === false) {
    return `（用户已关闭「全局记忆」，本会话不注入 ${entries.length} 条内容；仍可用 memory_search 按需检索。）`
  }
  const raw = readText(MEM_FILE)
  if (raw.length > 48 * 1024) {
    return `共 ${entries.length} 条（正文过大，仅注入索引；用 memory_search 取正文）\n` + entries.map((e) => `[${e.id}] ${e.date} · ${e.title}`).join('\n')
  }
  return entries.map((e) => `[${e.id}] ${e.date} · ${e.title}\n${e.text}`).join('\n\n')
}

function saveMemory(content, title) {
  const text = String(content || '').trim()
  if (!text) throw new Error('content 不能为空')
  ensureMemory()
  const entries = parseMemory()
  const dup = entries.find((e) => normalize(e.text) === normalize(text))
  if (dup) return { ok: true, id: dup.id, message: `已存在相同记忆，未重复写入（${dup.id}）` }
  const id = nextMemoryId(entries)
  const t = String(title || text.split(/[。；\n]/)[0]).slice(0, 40).trim() || '记录'
  const raw = readText(MEM_FILE)
  const base = raw.endsWith('\n') ? raw : raw + '\n'
  fs.writeFileSync(MEM_FILE, base + '\n' + `## [${id}] ${todayStr()} · ${t}\n\n${text}\n`, 'utf8')
  return { ok: true, id, message: `已写入长期记忆 ${id}：${t}` }
}

function deleteMemory(idOrQuery) {
  const entries = parseMemory()
  let target
  if (/^M\d{3,}$/i.test(String(idOrQuery || '').trim())) {
    target = entries.find((e) => e.id.toUpperCase() === String(idOrQuery).trim().toUpperCase())
    if (!target) return { ok: false, message: `没有 id 为 ${idOrQuery} 的记忆` }
  } else {
    const q = normalize(idOrQuery).toLowerCase()
    if (!q) return { ok: false, message: '需要 id 或关键词' }
    const hits = entries.filter((e) => (e.title + '\n' + e.text).toLowerCase().includes(q))
    if (!hits.length) return { ok: false, message: `没有命中「${idOrQuery}」的记忆` }
    if (hits.length > 1) return { ok: false, message: `命中 ${hits.length} 条，请用 id 精确删除：\n` + hits.map((e) => `${e.id} · ${e.title}`).join('\n') }
    target = hits[0]
  }
  const kept = []
  let skip = false
  for (const line of readText(MEM_FILE).replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^##\s+\[(M\d{3,})\]/)
    if (m) {
      skip = m[1] === target.id
      if (skip) continue
    }
    if (!skip) kept.push(line)
  }
  fs.writeFileSync(MEM_FILE, kept.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
  return { ok: true, message: `已删除 ${target.id} · ${target.title}`, count: parseMemory().length }
}

// ── knowledge base (SQLite FTS5, CJK bigrams) ────────────────────────────

let dbInstance = null

async function db() {
  if (dbInstance) return dbInstance
  const { DatabaseSync } = await import('node:sqlite')
  fs.mkdirSync(path.dirname(KB_DB), { recursive: true })
  const d = new DatabaseSync(KB_DB)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA synchronous = NORMAL')
  d.exec('CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT, path TEXT, body TEXT, terms TEXT)')
  d.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(terms, content='chunks', content_rowid='id')")
  d.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, terms) VALUES (new.id, new.terms);
  END`)
  d.exec(`CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, terms) VALUES ('delete', old.id, old.terms);
  END`)
  d.exec(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, terms) VALUES ('delete', old.id, old.terms);
    INSERT INTO chunks_fts(rowid, terms) VALUES (new.id, new.terms);
  END`)
  d.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)')
  dbInstance = d
  return d
}

/** CJK bigrams + latin tokens: FTS5's own tokenizers do not split Chinese. */
function termsOf(s) {
  const text = String(s || '').toLowerCase()
  const out = new Set(text.match(/[a-z0-9_]{2,}/g) || [])
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out].join(' ')
}

function chunkText(text) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK) chunks.push(clean.slice(i, i + CHUNK))
  return chunks.filter((c) => c.trim().length > 40)
}

function walkFiles(dir, acc, depth) {
  if (depth > 6 || acc.length >= MAX_FILES) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return
    if (e.name.startsWith('.') || ['node_modules', 'Library', 'Temp', 'obj', 'bin'].includes(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, acc, depth + 1)
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full)
  }
}

function indexFile(d, file) {
  const st = safeStat(file)
  if (!st || st.size === 0) return 0
  const known = d.prepare('SELECT v FROM meta WHERE k = ?').get('mtime:' + file)
  if (known && Number(known.v) === st.mtimeMs) return 0
  const text = readText(file)
  if (!text || text.length < 40) return 0
  const parts = chunkText(text)
  if (!parts.length) return 0
  d.prepare('DELETE FROM chunks WHERE path = ?').run(file)
  const ins = d.prepare('INSERT INTO chunks(doc, path, body, terms) VALUES (?,?,?,?)')
  for (const p of parts) ins.run(path.basename(file), file, p, termsOf(p))
  d.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('mtime:' + file, String(st.mtimeMs))
  return parts.length
}

let indexTask = { running: false, kind: '', total: 0, done: 0, startedAt: 0, finishedAt: 0, result: null, error: null }

function statsOf(d) {
  const s = d.prepare('SELECT COUNT(*) AS chunks, COUNT(DISTINCT path) AS docs, COALESCE(SUM(LENGTH(body)),0) AS bytes FROM chunks').get()
  return { docs: Number(s.docs), chunks: Number(s.chunks), bytes: Number(s.bytes) }
}

/** Batched + yielding: DatabaseSync is synchronous and would freeze the harness. */
function runIndexTask(files, kind) {
  if (indexTask.running) return { started: false, message: `已有索引任务在跑（${indexTask.done}/${indexTask.total}）`, task: indexTask }
  const t = { running: true, kind, total: files.length, done: 0, startedAt: Date.now(), finishedAt: 0, result: null, error: null }
  indexTask = t
  ;(async () => {
    try {
      const d = await db()
      for (let i = 0; i < files.length; i += 120) {
        const slice = files.slice(i, i + 120)
        d.exec('BEGIN')
        try {
          for (const f of slice) indexFile(d, f)
          d.exec('COMMIT')
        } catch (e) {
          try {
            d.exec('ROLLBACK')
          } catch {}
          throw e
        }
        t.done = Math.min(i + slice.length, files.length)
        await new Promise((r) => setTimeout(r, 15))
      }
      d.prepare("INSERT INTO meta(k, v) VALUES ('lastIndex', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(Date.now()))
      t.result = statsOf(d)
    } catch (e) {
      t.error = String((e && e.message) || e)
    } finally {
      t.running = false
      t.finishedAt = Date.now()
    }
  })()
  return { started: true, kind, total: files.length }
}

function addPath(target) {
  const t = String(target || '').trim()
  if (!t) return { ok: false, message: '需要提供 path' }
  const st = safeStat(t)
  if (!st) return { ok: false, message: `路径不存在：${t}` }
  const files = []
  if (st.isDirectory()) walkFiles(t, files, 0)
  else files.push(t)
  if (!files.length) return { ok: false, message: `没有可索引的文本文件：${t}` }
  const r = runIndexTask(files, 'add')
  return { ok: true, ...r, message: r.started ? `已开始索引 ${files.length} 个文件（后台执行）` : r.message }
}

async function searchKb(query, limit) {
  const d = await db()
  const terms = termsOf(query)
  if (!terms) return { hits: [], total: 0 }
  const n = Number(limit) > 0 ? Math.min(Number(limit), 20) : 5
  const expr = terms.split(' ').join(' OR ')
  const rows = d
    .prepare('SELECT c.doc, c.path, c.body FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE f.terms MATCH ? ORDER BY rank LIMIT ?')
    .all(expr, n)
  const total = Number(d.prepare('SELECT COUNT(*) AS n FROM chunks_fts f WHERE f.terms MATCH ?').get(expr).n)
  return { hits: rows.map((r) => ({ doc: r.doc, path: r.path, text: r.body })), total }
}

async function kbStatus() {
  try {
    const d = await db()
    const s = statsOf(d)
    const t = d.prepare("SELECT v FROM meta WHERE k = 'lastIndex'").get()
    return { root: KB_ROOT, exists: fs.existsSync(KB_ROOT), ...s, updatedAt: t ? Number(t.v) : 0, db: KB_DB }
  } catch (e) {
    return { root: KB_ROOT, exists: fs.existsSync(KB_ROOT), docs: 0, chunks: 0, bytes: 0, updatedAt: 0, error: String(e.message || e) }
  }
}

// ── temperature (Windows only, no admin, no third-party tools) ───────────

const PS_TEMP = String.raw`
$out = @{ cpu = $null; gpu = $null }
try {
  $c = (Get-Counter '\Thermal Zone Information(*)\Temperature' -ErrorAction SilentlyContinue).CounterSamples |
       Sort-Object CookedValue -Descending | Select-Object -First 1
  if ($c) { $out.cpu = [int][math]::Round($c.CookedValue - 273.15, 0) }
} catch {}
try {
  $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
  if (Test-Path $smi) {
    $g = & $smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($g) { $out.gpu = [int]$g.Trim() }
  }
} catch {}
$out | ConvertTo-Json -Compress
`

let tempCache = { at: 0, value: null }

function readTemps() {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ cpu: null, gpu: null, supported: false })
    import('node:child_process').then(({ execFile }) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_TEMP],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ cpu: null, gpu: null, error: String(err.message || err) })
          try {
            const p = JSON.parse(String(stdout).trim() || '{}')
            resolve({ cpu: p.cpu ?? null, gpu: p.gpu ?? null, supported: true })
          } catch {
            resolve({ cpu: null, gpu: null, supported: true })
          }
        },
      )
    })
  })
}

async function sampleTemps() {
  const now = Date.now()
  if (tempCache.value && now - tempCache.at < 2500) return tempCache.value
  const value = await readTemps()
  tempCache = { at: now, value }
  return value
}

// ── session transcript + handoff compression ─────────────────────────────

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Session logs are many concatenated zstd frames; a single call only decodes the first. */
function decompressAll(buf) {
  const parts = []
  let pos = 0
  let guard = 0
  while (pos < buf.length - 4 && guard++ < 200000) {
    if (!buf.slice(pos, pos + 4).equals(ZSTD_MAGIC)) {
      const next = buf.indexOf(ZSTD_MAGIC, pos)
      if (next < 0) break
      pos = next
      continue
    }
    const next = buf.indexOf(ZSTD_MAGIC, pos + 4)
    const end = next < 0 ? buf.length : next
    try {
      parts.push(zlib.zstdDecompressSync(buf.slice(pos, end)))
      pos = end
    } catch {
      pos += 4
    }
  }
  return Buffer.concat(parts)
}

function findSessionDir(sessionId) {
  const root = path.join(HOME, 'sessions')
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = path.join(root, d.name, sessionId)
      if (fs.existsSync(dir)) return dir
    }
  } catch {}
  return ''
}

function sessionCwd(sessionId) {
  const dir = findSessionDir(sessionId)
  if (!dir) return ''
  try {
    const name = path.basename(dir)
    const file = fs.readdirSync(dir).find((n) => /^session(\.[a-z0-9]+)?\.jsonl\.zstd$/.test(n))
    if (!file) return ''
    const text = decompressAll(fs.readFileSync(path.join(dir, file))).toString('utf8')
    const first = text.split('\n').find((l) => l.trim())
    const header = JSON.parse(first)
    return typeof header.cwd === 'string' ? header.cwd : ''
  } catch {
    return ''
  }
}

function transcriptOf(sessionId) {
  const dir = findSessionDir(sessionId)
  if (!dir) return { text: '', turns: 0 }
  const file = fs.readdirSync(dir).find((n) => /^session(\.[a-z0-9]+)?\.jsonl\.zstd$/.test(n))
  if (!file) return { text: '', turns: 0 }
  let raw = ''
  try {
    raw = decompressAll(fs.readFileSync(path.join(dir, file))).toString('utf8')
  } catch {
    return { text: '', turns: 0 }
  }
  const out = []
  let turns = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'user/message') {
      if ((ev.data && ev.data.source && ev.data.source.kind) !== 'user') continue
      const text = (ev.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      if (text.trim()) {
        out.push('【用户】' + text.trim())
        turns++
      }
    } else if (ev.type === 'assistant/message') {
      const content = (ev.data && ev.data.message && ev.data.message.content) || []
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      if (text.trim()) out.push('【助手】' + text.trim())
    }
  }
  let text = out.join('\n\n')
  if (text.length > MAX_TRANSCRIPT) {
    text = text.slice(0, 60000) + '\n\n……（中间省略）……\n\n' + text.slice(-60000)
  }
  return { text, turns }
}

function apiKey() {
  const m = readText(CRED_FILE).match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  return m ? m[1].trim() : ''
}

async function handoff(sessionId, prompt, extra) {
  const t = transcriptOf(sessionId)
  if (!t.text) return { ok: false, message: '这个会话还没有可压缩的内容（先聊几句）。' }
  const key = apiKey()
  if (!key) return { ok: false, message: '没有找到 DEEPSEEK_API_KEY（在 DSH 里登录后会自动写入 .credentials.yaml）。' }
  const instruction = String(prompt || '').trim() || DEFAULT_HANDOFF_PROMPT
  const extraText = String(extra || '').trim()
  const content = instruction + (extraText ? '\n\n附加要求：\n' + extraText : '') + '\n\n=== 对话全文 ===\n\n' + t.text
  const started = Date.now()
  try {
    const res = await fetch(process.env.DSH_HANDOFF_ENDPOINT || 'https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: process.env.DSH_HANDOFF_MODEL || 'deepseek-chat',
        messages: [{ role: 'user', content }],
        stream: false,
        max_tokens: 6000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(180000),
    })
    if (!res.ok) return { ok: false, message: `压缩失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}` }
    const data = await res.json()
    const summary = data?.choices?.[0]?.message?.content
    if (!summary) return { ok: false, message: '压缩失败：响应为空' }
    return { ok: true, summary: String(summary).trim(), transcriptChars: t.text.length, turns: t.turns, ms: Date.now() - started, usage: data.usage || null }
  } catch (e) {
    return { ok: false, message: `压缩请求失败：${String((e && e.message) || e)}` }
  }
}

// ── skills / MCP inventory + toggles ─────────────────────────────────────

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

function listSkillDir(dir, scope) {
  const items = []
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return items
  }
  for (const d of names) {
    if (d.isDirectory()) {
      const f = path.join(dir, d.name, 'SKILL.md')
      if (!fs.existsSync(f)) continue
      const fm = frontmatter(readText(f))
      items.push({ name: fm.name || d.name, description: (fm.description || '').slice(0, 120), scope, path: path.join(dir, d.name) })
    } else if (d.isFile() && d.name.endsWith('.md')) {
      const f = path.join(dir, d.name)
      const fm = frontmatter(readText(f))
      items.push({ name: fm.name || d.name.replace(/\.md$/, ''), description: (fm.description || '').slice(0, 120), scope, path: f })
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

function skillsSummary(cwd) {
  const agentsHome = process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents')
  const out = [...listSkillDir(path.join(agentsHome, 'skills'), 'user'), ...listSkillDir(path.join(HOME, 'skills'), 'dsh-user')]
  if (cwd) {
    out.push(...listSkillDir(path.join(cwd, '.agents', 'skills'), 'project'))
    out.push(...listSkillDir(path.join(cwd, '.dsh', 'skills'), 'project'))
  }
  return { count: out.length, items: out, disabled: readSettings().disabledSkills || [] }
}

function toggleSkill(name, enabled) {
  const target = String(name || '').trim()
  if (!target) return { ok: false, message: '需要 skill 名称' }
  const s = readSettings()
  const disabled = new Set(s.disabledSkills || [])
  const found = skillsSummary('').items.find((it) => it.name === target)
  const disabledPath = path.join(DISABLED_SKILLS, target)
  try {
    if (enabled === false) {
      const from = found ? found.path : disabledPath
      if (!fs.existsSync(from)) return { ok: false, message: `找不到 skill 目录：${from}` }
      fs.mkdirSync(DISABLED_SKILLS, { recursive: true })
      fs.renameSync(from, disabledPath)
      disabled.add(target)
      writeSettings({ disabledSkills: [...disabled] })
      return { ok: true, message: `已停用 ${target}（重启 DSH 后完全生效）` }
    }
    if (!fs.existsSync(disabledPath)) return { ok: false, message: `${target} 没有被停用` }
    const back = path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills')
    fs.mkdirSync(back, { recursive: true })
    fs.renameSync(disabledPath, path.join(back, target))
    disabled.delete(target)
    writeSettings({ disabledSkills: [...disabled] })
    return { ok: true, message: `已启用 ${target}` }
  } catch (e) {
    return { ok: false, message: `操作失败：${String((e && e.message) || e)}` }
  }
}

function mcpSummary() {
  const patch = readText(PATCH_FILE)
  const servers = []
  let cur = null
  for (const rawLine of patch.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (/^\s*-\s+id:/.test(line)) {
      if (cur && cur.serverName) servers.push(cur)
      cur = { id: line.replace(/^\s*-\s+id:\s*/, '').trim(), serverName: '', transport: '' }
      continue
    }
    const sn = cur && line.match(/^\s*serverName:\s*['"]?([^'"#]+)['"]?/)
    if (cur && sn) cur.serverName = sn[1].trim()
    const tr = cur && line.match(/^\s*transport:\s*['"]?([^'"#]+)/)
    if (cur && tr) cur.transport = tr[1].trim()
  }
  if (cur && cur.serverName) servers.push(cur)
  const off = new Set(readSettings().disabledMcp || [])
  return { count: servers.length, servers: servers.map((sv) => ({ ...sv, disabled: off.has(sv.id) })) }
}

/** Rewrite `disabled: true` on a patch row, with a timestamped backup. */
function setPatchDisabled(id, disabled) {
  const text = readText(PATCH_FILE)
  if (!text) return { ok: false, message: '读不到 cordis.patch.yml' }
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((l) => new RegExp(`^\\s*-\\s+id:\\s*['"]?${id}['"]?\\s*$`).test(l))
  if (idx < 0) return { ok: false, message: `patch 里没有 ${id}` }
  const indent = (lines[idx].match(/^\s*/) || [''])[0].length
  const childIndent = ' '.repeat(indent + 2)
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  fs.writeFileSync(path.join(BACKUP_DIR, `cordis.patch.${Date.now()}.yml`), text, 'utf8')
  const existing = lines.findIndex((l, k) => k > idx && k < idx + 4 && l.trim() === 'disabled: true')
  if (disabled) {
    if (existing > idx) return { ok: true, message: `${id} 已经是停用状态` }
    lines.splice(idx + 1, 0, `${childIndent}disabled: true`)
  } else {
    if (existing < 0) return { ok: true, message: `${id} 本来就是启用状态` }
    lines.splice(existing, 1)
  }
  fs.writeFileSync(PATCH_FILE, lines.join('\n'), 'utf8')
  return { ok: true, message: `${id} 已${disabled ? '停用' : '启用'}（重启 DSH 生效）` }
}

function toggleMcp(id, enabled) {
  const s = readSettings()
  const set = new Set(s.disabledMcp || [])
  const r = setPatchDisabled(id, enabled === false)
  if (!r.ok) return r
  if (enabled === false) set.add(id)
  else set.delete(id)
  writeSettings({ disabledMcp: [...set] })
  return r
}

function execSummary() {
  return {
    platform: process.platform,
    shell: IS_WIN ? 'PowerShell (pwsh_execute / pwsh_persistent)' : 'Bash (bash_execute)',
    tools: IS_WIN ? ['pwsh_execute', 'pwsh_persistent', 'fs_read', 'fs_write', 'fs_search'] : ['bash_execute', 'fs_read', 'fs_write', 'fs_search'],
  }
}

function memorySummary() {
  const entries = parseMemory()
  const s = readSettings()
  return { enabled: s.memoryEnabled !== false, file: MEM_FILE, bytes: safeStat(MEM_FILE)?.size ?? 0, count: entries.length }
}

// ── http ─────────────────────────────────────────────────────────────────

function json(res, code, value) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

let activePort = DEFAULT_PORT

function listenWithFallback(server, port) {
  return new Promise((resolve, reject) => {
    let p = port
    let attempts = 12
    const onError = (e) => {
      server.removeListener('error', onError)
      if (e.code === 'EADDRINUSE' && attempts-- > 0) {
        p += 1
        server.listen(p, HOST)
      } else reject(e)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(p)
    }
    server.on('error', onError)
    server.once('listening', onListening)
    server.listen(p, HOST)
  })
}

async function summaryOf(sessionId) {
  return {
    at: Date.now(),
    port: activePort,
    platform: process.platform,
    cwd: sessionCwd(sessionId) || process.cwd(),
    memory: memorySummary(),
    skills: skillsSummary(sessionCwd(sessionId) || ''),
    mcp: mcpSummary(),
    exec: execSummary(),
    kb: { ...(await kbStatus()), task: indexTask },
    hasApiKey: !!apiKey(),
  }
}

// ── tools ────────────────────────────────────────────────────────────────

const obj = (props, required) => ({ type: 'object', additionalProperties: false, properties: props, ...(required && required.length ? { required } : {}) })
const OUT = obj({ ok: { type: 'boolean' }, message: { type: 'string' }, count: { type: 'integer' }, id: { type: 'string' } }, ['ok', 'message'])
const render = (_a, v) => [{ type: 'text', text: String(v && v.message ? v.message : '') }]

/** @param ctx - host context. */
export function apply(ctx) {
  ensureMemory()

  // memory injection
  ctx.systemPrompt.variable('chatbox_compat_memory', () => memoryInjection())
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'chatbox-compat:long-term-memory',
        order: 8500,
        text: `# 长期记忆（跨会话）\n\n以下是用户长期沉淀的事实，视为可信背景；与当前对话的直接证据冲突时，以证据为准并更新记忆。需要新增或修正时调用 memory_save / memory_delete，不要只在回答里说「记下了」。\n\n{{chatbox_compat_memory}}`,
      }),
    'chatbox-compat: memory section',
  )

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      return res.end()
    }
    const url = new URL(req.url || '/', `http://${HOST}:${activePort}`)
    try {
      if (url.pathname === '/ping') return json(res, 200, { ok: true, name: 'dsh-chatbox-compat', port: activePort, version: '0.1.0' })
      if (url.pathname === '/summary') return json(res, 200, await summaryOf(url.searchParams.get('session') || ''))
      if (url.pathname === '/temp') return json(res, 200, { ...(await sampleTemps()), at: Date.now() })
      if (url.pathname === '/memory/list') {
        const entries = parseMemory()
        return json(res, 200, { ...memorySummary(), entries: entries.map((e) => ({ id: e.id, date: e.date, title: e.title, preview: e.text.slice(0, 140) })) })
      }
      if (url.pathname === '/memory/delete') return json(res, 200, deleteMemory(url.searchParams.get('id') || ''))
      if (url.pathname === '/memory/toggle') {
        const enabled = url.searchParams.get('enabled') !== '0'
        writeSettings({ memoryEnabled: enabled })
        return json(res, 200, { ok: true, enabled, message: enabled ? '全局记忆已开启' : '全局记忆已关闭' })
      }
      if (url.pathname === '/skills/toggle') return json(res, 200, toggleSkill(url.searchParams.get('name') || '', url.searchParams.get('enabled') !== '0'))
      if (url.pathname === '/mcp/toggle') return json(res, 200, toggleMcp(url.searchParams.get('id') || '', url.searchParams.get('enabled') !== '0'))
      if (url.pathname === '/kb/status') return json(res, 200, { task: indexTask, kb: await kbStatus() })
      if (url.pathname === '/kb/search') return json(res, 200, await searchKb(url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 5)))
      if (url.pathname === '/kb/reindex') {
        const root = url.searchParams.get('dir') || KB_ROOT
        const files = []
        if (fs.existsSync(root)) walkFiles(root, files, 0)
        return json(res, 200, runIndexTask(files, 'reindex'))
      }
      if (url.pathname === '/kb/add') return json(res, 200, addPath(url.searchParams.get('path') || ''))
      if (url.pathname === '/handoff') {
        let body = {}
        if (req.method === 'POST') {
          const chunks = []
          for await (const c of req) chunks.push(c)
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {}
        }
        return json(res, 200, await handoff(body.session || url.searchParams.get('session') || '', body.prompt, body.extra))
      }
      return json(res, 404, { error: 'not-found' })
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) })
    }
  })

  server.on('error', (e) => console.error('[chatbox-compat] http:', e.message))
  listenWithFallback(server, DEFAULT_PORT)
    .then((p) => {
      activePort = p
      console.info(`[chatbox-compat] listening on http://${HOST}:${p}`)
    })
    .catch((e) => console.error('[chatbox-compat] failed to listen:', e.message))

  ctx.effect(() => () => server.close(), 'chatbox-compat: http server')

  // tools
  ctx.tools.register({
    name: 'memory_save',
    description: '把一条值得长期记住的事实写入长期记忆（跨会话生效，下一轮即出现在系统提示里）。适合用户偏好、稳定环境与路径、项目约定、踩过的坑、重要决策。不要存一次性进度、临时结果、密钥口令。',
    parameters: obj({ content: { type: 'string', description: '要记住的事实，一到三句话，自包含。' }, title: { type: 'string', description: '短标题（可选）。' } }, ['content']),
    output: { schema: OUT, render },
    async execute(args) {
      return saveMemory(args.content, args.title)
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description: '按关键词在长期记忆里搜索，返回命中条目全文。',
    parameters: obj({ query: { type: 'string', description: '关键词；空格分隔表示全部命中。' }, limit: { type: 'integer' } }, ['query']),
    output: { schema: OUT, render },
    async execute(args) {
      const terms = normalize(args.query).toLowerCase().split(' ').filter(Boolean)
      if (!terms.length) throw new Error('query 不能为空')
      const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 20) : 5
      const hits = parseMemory().filter((e) => {
        const hay = (e.title + '\n' + e.text).toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      if (!hits.length) return { ok: true, count: 0, message: `没有命中「${args.query}」的记忆` }
      return { ok: true, count: hits.length, message: `命中 ${hits.length} 条：\n\n` + hits.slice(0, limit).map((e) => `[${e.id}] ${e.date} · ${e.title}\n${e.text}`).join('\n\n---\n\n') }
    },
  })

  ctx.tools.register({
    name: 'memory_delete',
    description: '删除长期记忆条目。用 id（如 M016）或关键词；关键词必须唯一命中，否则列出候选并拒绝执行。',
    parameters: obj({ id: { type: 'string' }, query: { type: 'string' } }),
    output: { schema: OUT, render },
    async execute(args) {
      return deleteMemory(args.id || args.query || '')
    },
  })

  ctx.tools.register({
    name: 'memory_list',
    description: '列出长期记忆的所有条目（id、日期、标题）。',
    parameters: obj({ limit: { type: 'integer' } }),
    output: { schema: OUT, render },
    async execute(args) {
      const entries = parseMemory()
      const limit = Number(args.limit) > 0 ? Number(args.limit) : entries.length
      const rows = entries.slice(-limit).map((e) => `${e.id} · ${e.date} · ${e.title}`)
      return { ok: true, count: entries.length, message: `共 ${entries.length} 条：\n${rows.join('\n') || '（空）'}` }
    },
  })

  ctx.tools.register({
    name: 'kb_search',
    description: '在工作区知识库（本地 SQLite 全文索引）里检索，返回最相关的代码/文档片段。',
    parameters: obj({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']),
    output: { schema: OUT, render },
    async execute(args) {
      const r = await searchKb(args.query, Number(args.limit) || 5)
      if (!r.hits.length) return { ok: true, count: 0, message: `没有命中「${args.query}」。可先用 kb_add 建索引。` }
      return {
        ok: true,
        count: r.hits.length,
        message: `命中 ${r.total} 个片段，前 ${r.hits.length} 条：\n\n` + r.hits.map((x, i) => `[${i + 1}] ${x.doc}\n${x.path}\n${x.text.slice(0, 600)}${x.text.length > 600 ? '…' : ''}`).join('\n\n---\n\n'),
      }
    },
  })

  ctx.tools.register({
    name: 'kb_add',
    description: '把一个文件或目录加入知识库索引（递归，文本类扩展名；未改动的文件会跳过）。',
    parameters: obj({ path: { type: 'string' } }, ['path']),
    output: { schema: OUT, render },
    async execute(args) {
      return addPath(args.path)
    },
  })

  ctx.tools.register({
    name: 'kb_list',
    description: '列出知识库规模（文档数 / 片段数 / 体积）与索引根目录。',
    parameters: obj({}),
    output: { schema: OUT, render },
    async execute() {
      const s = await kbStatus()
      if (!s.docs) return { ok: true, count: 0, message: `知识库为空（根目录 ${s.root}）。用 kb_add 或面板里的「重建索引」。` }
      return { ok: true, count: s.docs, message: `知识库：${s.docs} 个文档 / ${s.chunks} 个片段 / ${Math.round(s.bytes / 1024)} KB\n根目录 ${s.root}` }
    },
  })
}
