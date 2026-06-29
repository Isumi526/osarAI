// ============================================================
//  scripts/next-target.mjs
//  Notionバックログから「要件定義済み」を優先度順で全件取得し、
//  次に着手すべきターゲット（最優先の1件）を出力する。
//  - notion-search の取りこぼし対策（確実に全件・フィルタはAPI側で）
//  - 旧 databases/query が version/endpoint エラーなら
//    data_sources/query (Notion-Version: 2025-09-03) にフォールバック
//
//  ※バックログDBは sido / osarAI / Garage Connect の3プロジェクトで共用。
//    タスクは「案件名」relation（説明=「案件管理マスタと紐付け」。"案件名 1" ではない）で
//    各案件に紐づく。本スクリプトは .env の BACKLOG_PROJECT_ID（自分の案件page_id）で絞り、
//    自分の案件のタスクだけを拾う。
//
//  使い方: node scripts/next-target.mjs
//  必要env(.env): NOTION_TOKEN, BACKLOG_PROJECT_ID（必須・自分の案件page_id）, (任意) BACKLOG_DB_ID
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

const env = loadEnv(resolve(ROOT, '.env'))
const TOKEN          = process.env.NOTION_TOKEN || env.NOTION_TOKEN
const DB_ID          = process.env.BACKLOG_DB_ID || env.BACKLOG_DB_ID || '6e7dd24739dd431688564b12f64d8ebd'
const DATA_SOURCE_ID = process.env.BACKLOG_DATA_SOURCE_ID || env.BACKLOG_DATA_SOURCE_ID || 'a7f5a28f-22af-4bc1-a512-4d427a934f31'
const PROJECT_ID     = process.env.BACKLOG_PROJECT_ID || env.BACKLOG_PROJECT_ID

if (!TOKEN) { console.error('✗ NOTION_TOKEN が .env にありません'); process.exit(1) }
// 【安全装置】案件page_id 未設定なら即停止。フィルタなしで全プロジェクトのタスクを拾う事故を防ぐ。
if (!PROJECT_ID) { console.error('✗ BACKLOG_PROJECT_ID が .env にありません（自分の案件page_idを設定してください）'); process.exit(1) }

// 既知の案件page_id → 表示名（共用バックログDBの各プロジェクト）
const PROJECT_NAMES = {
  '3540ff81-c56b-802e-871d-ca995e01718f': 'SIDO',
  '37a0ff81-c56b-81d9-a527-eebd543686c3': 'osarAI',
  '3690ff81-c56b-8099-94dc-d196307d2b79': 'Garage Connect',
}
const norm = (id) => (id || '').replace(/-/g, '')
const PROJECT_NAME = Object.entries(PROJECT_NAMES).find(([id]) => norm(id) === norm(PROJECT_ID))?.[1]
  || `(page_id …${norm(PROJECT_ID).slice(-6)})`

const STATUS_PROP   = 'ステータス'
const PRIORITY_PROP = '優先順位'
const TITLE_PROP    = 'タスク名'
const PROJECT_PROP  = '案件名'   // relation（説明=「案件管理マスタと紐付け」）。"案件名 1" ではない方
const TARGET_STATUS = '要件定義済み'
const PRIORITY_RANK = { '緊急': 0, '高': 1, '中': 2, '低': 3 }
// --board: 自案件の「全ステータス」を取得（/run ステートマシン用の盤面スナップショット）。
// 既定（/next 用・引数なし）: ステータス＝要件定義済み のみ（従来どおり・後方互換）。
// 【仕様】案件名が未設定（空）のタスクは relation 一致しないため、どのプロジェクトでも拾わない（＝自然に除外）。
const BOARD = process.argv.slice(2).includes('--board')
const filter = BOARD
  ? { property: PROJECT_PROP, relation: { contains: PROJECT_ID } }
  : {
      and: [
        { property: STATUS_PROP,  status: { equals: TARGET_STATUS } },
        { property: PROJECT_PROP, relation: { contains: PROJECT_ID } },
      ],
    }

function queryDatabase(cursor) {
  return fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
  })
}

function queryDataSource(cursor) {
  return fetch(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
  })
}

async function paginate(doQuery) {
  const results = []
  let cursor
  do {
    const res = await doQuery(cursor)
    if (!res.ok) return { ok: false, status: res.status, text: await res.text() }
    const j = await res.json()
    results.push(...(j.results || []))
    cursor = j.has_more ? j.next_cursor : undefined
  } while (cursor)
  return { ok: true, results }
}

const title    = (p) => (p.properties?.[TITLE_PROP]?.title || []).map((t) => t.plain_text).join('') || '(無題)'
const priority = (p) => p.properties?.[PRIORITY_PROP]?.select?.name ?? null
const statusOf = (p) => p.properties?.[STATUS_PROP]?.status?.name ?? '(未設定)'
const riskOf   = (p) => p.properties?.['リスク']?.select?.name ?? null
const dodaiOf  = (p) => p.properties?.['土台']?.checkbox === true
const tagsOf   = (p) => (p.properties?.['タグ']?.multi_select ?? []).map((o) => o.name)

// --board: 全ステータスをグループ表示（ステートマシンが盤面を読むための機械可読寄り出力）
function printBoard(results) {
  const ORDER = ['未整理', '要回答', '要件定義済み', '進行中', 'レビュー待ち', '本番待ち', '保留', '完了']
  const groups = new Map(ORDER.map((s) => [s, []]))
  for (const p of results) {
    const s = statusOf(p)
    if (!groups.has(s)) groups.set(s, [])
    groups.get(s).push(p)
  }
  const rank = (p) => PRIORITY_RANK[priority(p)] ?? 9
  for (const arr of groups.values()) {
    arr.sort((a, b) => (rank(a) - rank(b)) || (a.created_time || '').localeCompare(b.created_time || ''))
  }
  console.log(`▶ 対象プロジェクト: ${PROJECT_NAME} — 盤面スナップショット（全ステータス）`)
  const counts = [...groups.entries()].map(([s, arr]) => `${s}:${arr.length}`)
  console.log(`■ 件数: ${counts.join(' / ')}`)
  for (const [s, arr] of groups) {
    if (arr.length === 0) continue
    console.log(`\n## ${s} (${arr.length})`)
    for (const p of arr) {
      const tg = tagsOf(p)
      const risk = riskOf(p) ?? '-'
      const dodai = dodaiOf(p) ? '🧱' : ''
      console.log(`  - [${priority(p) ?? '-'}/${risk}${dodai}] ${title(p)}${tg.length ? ' 〔' + tg.join(',') + '〕' : ''}`)
      console.log(`    ${p.url}`)
    }
  }
}

async function main() {
  // 旧 databases/query を試し、ダメなら data_sources/query にフォールバック
  let out = await paginate(queryDatabase)
  if (!out.ok) {
    console.error(`… databases/query NG (HTTP ${out.status}) → data_sources/query (2025-09-03) で再試行`)
    out = await paginate(queryDataSource)
    if (!out.ok) {
      console.error(`✗ data_sources/query も失敗 (HTTP ${out.status}): ${out.text}`)
      process.exit(1)
    }
  }

  // --board: 全ステータスの盤面を出して終了（/run ステートマシン用）
  if (BOARD) { printBoard(out.results); return }

  const rows = out.results.sort((a, b) => {
    const ra = PRIORITY_RANK[priority(a)] ?? 9
    const rb = PRIORITY_RANK[priority(b)] ?? 9
    if (ra !== rb) return ra - rb
    return (a.created_time || '').localeCompare(b.created_time || '')   // 同率は作成日古い順
  })

  console.log(`▶ 対象プロジェクト: ${PROJECT_NAME}（案件で絞り込み中）`)
  console.log(`■ 要件定義済み（Readyキュー）: ${rows.length}件 — 優先度順`)
  if (rows.length === 0) {
    console.log('  （対象なし）')
    console.log('\n=== 次のターゲット ===\n（なし）')
    return
  }
  rows.forEach((p, i) => {
    console.log(`  ${i + 1}. [${priority(p) ?? '-'}] ${title(p)}`)
    console.log(`     ${p.url}`)
  })

  const t = rows[0]
  console.log('\n=== 次のターゲット ===')
  console.log(`[${priority(t) ?? '-'}] ${title(t)}`)
  console.log(`URL: ${t.url}`)
  console.log(`NEXT_TARGET_URL=${t.url}`)
}

main().catch((e) => { console.error('✗ 実行エラー:', e); process.exit(1) })
