// ============================================================
//  scripts/independent-review.mjs
//  Claude製コードを「独立した別AI(Gemini)」でレビューする専用スクリプト。
//   - レビュー専用キー GEMINI_REVIEW_API_KEY（アプリの解析キーとは別）。
//   - .kody/rules/*.md（ルール）＋ /run から渡される ticket要件 を Gemini に与え、
//     diff をレビューさせ JSON で受ける。コードは一切書き換えない（レビュー専用）。
//   - critical/🔴 があれば対象Notionチケットに「要人間verdict」を立てる（--ticket-id 指定時）。
//  使い方:
//    node scripts/independent-review.mjs [<diff範囲>] [--json] [--dry-run]
//        [--ticket-id <NotionページID>] [--ticket-file <要件mdパス>]   (要件は stdin でも可)
//    既定 diff範囲 = origin/main...HEAD
//  env(.env): GEMINI_REVIEW_API_KEY(必須), GEMINI_REVIEW_MODEL(任意), NOTION_TOKEN(Notion更新時)
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function loadEnv(p) { const o = {}; try { for (const l of readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '') } } catch {} return o }
const env = loadEnv(resolve(ROOT, '.env'))

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const DRY = has('--dry-run'); const JSON_ONLY = has('--json')
const TICKET_ID = val('--ticket-id'); const TICKET_FILE = val('--ticket-file')
const RUNS = Math.max(1, Number(val('--runs')) || 1)   // N回実行して findings を union（gateの非決定性対策）
const RUNS_VAL = val('--runs')
const RANGE = argv.find((a) => !a.startsWith('--') && a !== TICKET_ID && a !== TICKET_FILE && a !== RUNS_VAL) || 'origin/main...HEAD'

const API_KEY = process.env.GEMINI_REVIEW_API_KEY || env.GEMINI_REVIEW_API_KEY
const MODEL = process.env.GEMINI_REVIEW_MODEL || env.GEMINI_REVIEW_MODEL || 'gemini-3.5-flash'   // docs現行。env上書き可
if (!API_KEY) { console.error('✗ GEMINI_REVIEW_API_KEY が未設定（root .env）。レビューを中止。'); process.exit(2) }

// ルール読み込み
const RULES_DIR = resolve(ROOT, '.kody/rules')
const rules = existsSync(RULES_DIR)
  ? readdirSync(RULES_DIR).filter((f) => f.endsWith('.md')).map((f) => `# rule: ${f}\n${readFileSync(resolve(RULES_DIR, f), 'utf8')}`).join('\n\n')
  : ''

// accepted-findings レジストリ（.kody/accepted.yml）。簡易パーサ（依存なし）。
function unq(s) { return (s || '').replace(/^["']|["']$/g, '').trim() }
function parseAcceptedYml(text) {
  const entries = []; let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*#/.test(line) || !line.trim()) continue
    const mItem = line.match(/^\s*-\s*(\w+):\s*(.*)$/)   // "- rule: x"（エントリ開始）
    const mKey  = line.match(/^\s+(\w+):\s*(.*)$/)        // "  target: x"
    if (mItem) { if (cur) entries.push(cur); cur = { [mItem[1]]: unq(mItem[2]) } }
    else if (mKey && cur) { cur[mKey[1]] = unq(mKey[2]) }
  }
  if (cur) entries.push(cur)
  return entries.filter((e) => e.rule || e.target)
}
const ACCEPTED_PATH = resolve(ROOT, '.kody/accepted.yml')
const accepted = existsSync(ACCEPTED_PATH) ? parseAcceptedYml(readFileSync(ACCEPTED_PATH, 'utf8')) : []
// finding が accepted に一致するか（rule部分一致 ＋ target が file/message に含まれる）
function matchAccepted(f) {
  const fr  = (f.rule || '').toLowerCase().replace(/\.md$/, '')
  const hay = `${f.file || ''} ${f.message || ''}`.toLowerCase()
  return accepted.find((e) => {
    const er = (e.rule || '').toLowerCase().replace(/\.md$/, '')
    const ruleMatch   = er && (fr.includes(er) || er.includes(fr))
    const targetMatch = e.target && hay.includes(String(e.target).toLowerCase())
    return ruleMatch && targetMatch
  })
}
// diff
let diff = ''
try { diff = execSync(`git diff ${RANGE}`, { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 }).toString() }
catch (e) { console.error(`✗ git diff ${RANGE} 失敗: ${e.message}`); process.exit(2) }
if (!diff.trim()) { console.error(`（diff が空: ${RANGE}）レビュー対象なし。`); process.exit(0) }
// ticket要件（intent照合②）
let ticket = ''
if (TICKET_FILE && existsSync(TICKET_FILE)) ticket = readFileSync(TICKET_FILE, 'utf8')
else { try { ticket = readFileSync(0, 'utf8') } catch {} }   // stdin
const intentNote = ticket.trim() ? '' : '※ticket要件が未指定のため、意図照合(②)はスキップ。ルール照合(①)のみ実施。'

const SYSTEM = [
  'あなたは独立したコードレビュアー（Claude以外）。下記のレビュールールと（あれば）チケット要件に照らして diff をレビューする。',
  'コードは一切書き換えず、指摘のみを返す。曖昧な憶測指摘より、ルール・要件に明確に反するものを優先。',
  '出力は必ず次の形の JSON のみ（値は実際の内容で埋める）: {"findings":[{"severity":"critical|high|medium|low","file":"path","line":0,"rule":"ルール名","message":"指摘内容"}],"accessRuleEnforced":"外部/anon導線のトークン照合が diff 内でどう担保されているかを1行で（該当なければ その旨）","verdictSuggestion":"block|warn|pass"}',
].join('\n')
const USER = `# レビュールール\n${rules || '(なし)'}\n\n# チケット要件(意図照合用)\n${ticket.trim() || '(未指定)'}\n${intentNote}\n\n# 対象 diff (${RANGE})\n\`\`\`diff\n${diff.slice(0, 600000)}\n\`\`\``

async function callGemini() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: USER }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? ''
  try { return JSON.parse(text) } catch { throw new Error(`Gemini 応答が JSON でない: ${text.slice(0, 200)}`) }
}

async function flagNotion(crit, summary) {
  if (!TICKET_ID) { console.log(`  [TODO] critical検知だが --ticket-id 未指定 → 対象チケットに手動で「要人間verdict」を立ててください。`); return }
  const TOKEN = process.env.NOTION_TOKEN || env.NOTION_TOKEN
  if (!TOKEN) { console.log('  [TODO] NOTION_TOKEN 未設定 → Notion更新スキップ'); return }
  const H = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }
  const body = `🔴 独立レビュー(Gemini ${MODEL}): critical ${crit.length}件 — 要人間verdict\n` + crit.map((f) => `・${f.file}:${f.line} [${f.rule}] ${f.message}`).join('\n')
  const callout = { object: 'block', type: 'callout', callout: { rich_text: [{ type: 'text', text: { content: body.slice(0, 1900) } }], icon: { type: 'emoji', emoji: '🔴' } } }
  const r = await fetch(`https://api.notion.com/v1/blocks/${TICKET_ID}/children`, { method: 'PATCH', headers: H, body: JSON.stringify({ children: [callout] }) })
  console.log(`  Notion要人間verdict: ${r.ok ? 'ok' : 'NG ' + (await r.text()).slice(0, 120)}`)
  try { execSync(`node ${resolve(ROOT, 'scripts/notify-humanball.mjs')} --kind 要人間verdict --task "独立レビュー" --detail ${JSON.stringify(`critical ${crit.length}件(${RANGE})。要人間verdict。`)}`, { stdio: 'ignore' }) } catch {}
}

// N回実行して findings を union（rule|file|severity でdedup）。どれか1回でも未accept🔴が出れば
// union に残る＝block。temperature=0 でも残る揺れに対する保険（prodゲートを保守的に）。
const runs = []
for (let i = 0; i < RUNS; i++) {
  runs.push(await callGemini().catch((e) => { console.error('✗ ' + e.message); process.exit(2) }))
}
const _seen = new Set()
const _union = []
for (const r of runs) for (const f of (Array.isArray(r.findings) ? r.findings : [])) {
  const k = `${(f.rule || '').toLowerCase().replace(/\.md$/, '')}|${f.file || ''}|${(f.severity || '').toLowerCase()}`
  if (_seen.has(k)) continue
  _seen.add(k); _union.push(f)
}
const result = {
  findings: _union,
  accessRuleEnforced: runs[runs.length - 1]?.accessRuleEnforced ?? '-',
  verdictSuggestion: runs.some((r) => r.verdictSuggestion === 'block') ? 'block' : (runs[0]?.verdictSuggestion ?? '-'),
  runs: RUNS,
}
const findings = result.findings
// 各 finding に accepted 情報を付与
for (const f of findings) { f._accepted = matchAccepted(f) || null }
const crit = findings.filter((f) => /critical/i.test(f.severity || ''))
const high = findings.filter((f) => /high/i.test(f.severity || ''))
const unacceptedCrit = crit.filter((f) => !f._accepted)
const unacceptedSevere = findings.filter((f) => /critical|high/i.test(f.severity || '') && !f._accepted)
const acceptedFindings = findings.filter((f) => f._accepted)

// verdict は「未acceptの critical/🔴 が1件以上」なら block、それ以外は pass（accepted は除外）
const verdict = unacceptedCrit.length >= 1 ? 'block' : 'pass'

// riskClass: 機微な差分 or 未acceptの high/critical があれば high
function computeRisk() {
  const hi = /(^|\n)[+-].*supabase\/migrations\//.test(diff) || /supabase\/migrations\//.test(diff)
    || /supabase\/functions\//.test(diff)
    || (/config\.toml/.test(diff) && /verify_jwt/.test(diff))
    || /stripe|invoice|payment|subscription|billing|customers|interactions/i.test(diff)
    || /webhook|auth\/callback|push_tokens|service_role/i.test(diff)
    || unacceptedSevere.length > 0
  return hi ? 'high' : 'low'
}
const riskClass = computeRisk()
const acceptedSummary = acceptedFindings.map((f) => `${f.rule}:${f._accepted.target}(tracked:${f._accepted.ticket})`)

result.verdict = verdict
result.riskClass = riskClass
result.accepted = acceptedSummary

if (JSON_ONLY) { console.log(JSON.stringify(result)); }
else {
  console.log(`\n=== 独立レビュー (Gemini ${MODEL}) ${RANGE} ===`)
  if (intentNote) console.log(intentNote)
  console.log(`findings: 🔴critical ${crit.length}(未accept ${unacceptedCrit.length}) / high ${high.length} / 計 ${findings.length}`)
  for (const f of findings) console.log(`  [${f.severity}]${f._accepted ? ' accepted(tracked:' + f._accepted.ticket + ')' : ''} ${f.file}:${f.line} (${f.rule}) ${f.message}`)
  if (acceptedSummary.length) console.log(`accepted(block除外): ${acceptedSummary.join(' / ')}`)
  console.log(`accessRuleEnforced: ${result.accessRuleEnforced ?? '-'}`)
  console.log(`verdict: ${verdict}  /  riskClass: ${riskClass}`)
  console.log(`\n📋ダイジェスト用: 独立レビュー=🔴${crit.length}(未accept${unacceptedCrit.length})/high${high.length}・verdict=${verdict}・risk=${riskClass}`)
}
// --json は機械可読（ship ゲート等）。flagNotion 等の副作用/追加出力は行わず JSON のみ。
if (unacceptedCrit.length && !JSON_ONLY) {
  if (DRY) console.error(`[dry-run] 未accept critical ${unacceptedCrit.length}件 → Notion更新は行わない（標準出力のみ）。`)
  else await flagNotion(unacceptedCrit, result)
}
// verdict=block（未accept critical あり）は非ゼロで返す（/ship/run が拾えるように）
process.exit(verdict === 'block' ? 1 : 0)
