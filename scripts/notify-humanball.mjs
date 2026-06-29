// ============================================================
//  scripts/notify-humanball.mjs
//  人ボール（要回答/要対応/ship承認）が発生したとき、本人に LINE 通知を送る。
//  - これは「本人への個人通知」であり、hard-stop の「外部一斉送信」には当たらない（許可）。
//  - best-effort：失敗しても自走は止めない（必ず exit 0）。
//  - HUMANBALL_WEBHOOK_URL が未設定なら何もせず終了。
//
//  使い方:
//    node scripts/notify-humanball.mjs \
//      --kind 要回答 --task "<タスク名>" --detail "<質問+案や理由>" [--url "<セッションurl>"]
//  必要env(.env): HUMANBALL_WEBHOOK_URL, HUMANBALL_WEBHOOK_SECRET
// ============================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnv(p) {
  const out = {}
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* ignore */ }
  return out
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) { out[key] = true }
      else { out[key] = next; i++ }
    }
  }
  return out
}

const env = loadEnv(resolve(ROOT, '.env'))
const URL    = process.env.HUMANBALL_WEBHOOK_URL || env.HUMANBALL_WEBHOOK_URL
const SECRET = process.env.HUMANBALL_WEBHOOK_SECRET || env.HUMANBALL_WEBHOOK_SECRET

if (!URL) {
  // URL未設定なら何もせず正常終了（best-effort）
  process.exit(0)
}

const args = parseArgs(process.argv.slice(2))
const DEFAULT_URL = 'https://claude.ai/code'   // Claude Code Remote Control の固定入口URL
const payload = {
  project: 'osarAI',
  secret: SECRET || '',
  kind:   typeof args.kind === 'string' ? args.kind : '',
  // sido と同一LINEへ送るため、本文(task)に必ず [osarAI] 接頭辞を付けて出所を可視化する。
  // （webhook(GAS)側が payload.project を本文に出すか不明なため、確実に見えるよう task 側で前置）
  task:   '[osarAI] ' + (typeof args.task === 'string' ? args.task : ''),
  detail: typeof args.detail === 'string' ? args.detail : '',
  url:    typeof args.url === 'string' ? args.url : DEFAULT_URL,
}

try {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // GAS は失敗時も HTTP 200 を返し、本文 {"ok":false} で失敗を表す。
  // よって HTTP ステータスだけでなく、レスポンス本文の ok フィールドで成否を判定する。
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = null }
  if (res.ok && body?.ok === true) {
    console.log(`✓ humanball通知を送信 (${payload.kind}: ${payload.task})`)
  } else {
    console.error(`! humanball通知に失敗 (HTTP ${res.status} / body: ${text})。自走は継続します。`)
  }
} catch (e) {
  console.error(`! humanball通知に失敗 (${e?.message || e})。自走は継続します。`)
}

// 通知は best-effort。何があっても自走を止めない。
process.exit(0)
