// ============================================================
//  scripts/dispatcher.mjs
//  「決断の瞬間」だけ人に通知するディスパッチャ。/run 末尾から呼ぶ＋単体実行も可。
//   - 判定材料は既存プロパティのみ（ステータス/リスク/土台/優先度/案件/エピック）。
//   - dedup: .dispatcher-state.json（git管理外）。キーは `${page_id}:${status}` に統一。
//     毎実行の冒頭でプルーニング（現盤面とstatusが違う/存在しないキーを削除）→差し戻し再入で再通知。
//   - 初回統合: プルーン後 state が空なら、5トリガー個別ではなく
//     🧱土台＋レビュー待ち＋要回答 を1メッセージに統合して1回だけ送信し全件キーを保存。
//   - 二重起動は flock（ロックファイル）で弾く。配信は既存 notify-humanball.mjs。
//  使い方: node scripts/dispatcher.mjs [--dry-run]
//  env(.env): NOTION_TOKEN, BACKLOG_PROJECT_ID,
//             BACKLOG_DATA_SOURCE_ID(既定 a7f5a28f-22af-4bc1-a512-4d427a934f31),
//             (通知) HUMANBALL_WEBHOOK_URL / _SECRET
// ============================================================
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, readFileSync as rf } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.slice(2).includes('--dry-run')
const REVIEW_BATCH_THRESH = 5

function loadEnv(p) {
  const out = {}
  try { for (const l of readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '') } } catch { /* */ }
  return out
}
const env = loadEnv(resolve(ROOT, '.env'))
const TOKEN = process.env.NOTION_TOKEN || env.NOTION_TOKEN
const PROJECT_ID = process.env.BACKLOG_PROJECT_ID || env.BACKLOG_PROJECT_ID
// 未通知の保留(レビュー待ち＋要回答)の最古経過がこれを超えたら、閾値未満でもバッチflush（既定24h・env上書き可）
const _maxAge = Number(process.env.MAX_AGE_H ?? env.MAX_AGE_H)
const MAX_AGE_H = (Number.isFinite(_maxAge) && _maxAge > 0) ? _maxAge : 24
const DATA_SOURCE_ID = process.env.BACKLOG_DATA_SOURCE_ID || env.BACKLOG_DATA_SOURCE_ID || 'a7f5a28f-22af-4bc1-a512-4d427a934f31'
const STATE_PATH = resolve(ROOT, 'scripts/.dispatcher-state.json')
const LOCK_PATH = resolve(ROOT, 'scripts/.dispatcher.lock')
if (!TOKEN || !PROJECT_ID) { console.error('✗ NOTION_TOKEN / BACKLOG_PROJECT_ID が必要'); process.exit(1) }

const H = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }
const norm = (id) => (id || '').replace(/-/g, '')
const keyOf = (r) => `${norm(r.id)}:${r.status}`   // ← dedupキー統一: page_id:status

// ── flock: 二重起動を弾く（PIDベース・stale は奪取）──
let lockFd = null
function acquireLock() {
  for (let i = 0; i < 2; i++) {
    try { lockFd = openSync(LOCK_PATH, 'wx'); writeFileSync(LOCK_PATH, String(process.pid)); return true }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      let pid = 0; try { pid = parseInt(rf(LOCK_PATH, 'utf8'), 10) || 0 } catch { /* */ }
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true } } catch { alive = false }
      if (alive) { console.error(`✗ dispatcher 既に実行中 (pid ${pid})。終了。`); process.exit(0) }
      try { unlinkSync(LOCK_PATH) } catch { /* */ } // stale → 奪取して再試行
    }
  }
  return false
}
function releaseLock() { try { if (lockFd !== null) closeSync(lockFd) } catch {} try { unlinkSync(LOCK_PATH) } catch {} }

async function queryAll() {
  const results = []; let cursor
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ filter: { property: '案件名', relation: { contains: PROJECT_ID } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    })
    if (!res.ok) { console.error(`✗ query NG ${res.status}: ${await res.text()}`); releaseLock(); process.exit(1) }
    const j = await res.json(); results.push(...(j.results || [])); cursor = j.has_more ? j.next_cursor : undefined
  } while (cursor)
  return results
}
const P = (p) => ({
  id: p.id,
  title: (p.properties?.['タスク名']?.title || []).map((t) => t.plain_text).join('') || '(無題)',
  status: p.properties?.['ステータス']?.status?.name ?? '(未設定)',
  risk: p.properties?.['リスク']?.select?.name ?? null,
  dodai: !!p.properties?.['土台']?.checkbox,
  epic: p.properties?.['エピック']?.select?.name ?? '(未分類)',
  url: p.url,
  lastEdited: p.last_edited_time ?? null,   // v1: 「現statusに入った時刻」の近似
})

const loadState = () => { try { return new Set(JSON.parse(readFileSync(STATE_PATH, 'utf8'))) } catch { return new Set() } }
const saveState = (set) => writeFileSync(STATE_PATH, JSON.stringify([...set], null, 0))
function notify(kind, task, detail) {
  console.log(`  → notify[${kind}] ${task}: ${detail}`)
  if (DRY) return
  try { execFileSync('node', [resolve(ROOT, 'scripts/notify-humanball.mjs'), '--kind', kind, '--task', task, '--detail', detail], { stdio: 'ignore' }) } catch { /* best-effort */ }
}
const riskCounts = (arr) => ({
  red: arr.filter((r) => (r.risk || '').includes('🔴')).length,
  yel: arr.filter((r) => (r.risk || '').includes('🟡')).length,
  grn: arr.filter((r) => (r.risk || '').includes('🟢')).length,
})

async function main() {
  acquireLock()
  try {
    const rows = (await queryAll()).map(P)
    const stateRaw = loadState()

    // ── プルーニング: 現盤面の有効キー以外（status変化/ページ消滅）を除去 ──
    const validKeys = new Set(rows.map(keyOf))
    const pruned = [...stateRaw].filter((k) => !validKeys.has(k))
    const state = new Set([...stateRaw].filter((k) => validKeys.has(k)))

    const review = rows.filter((r) => r.status === 'レビュー待ち')
    const dodaiReview = review.filter((r) => r.dodai)
    const answers = rows.filter((r) => r.status === '要回答')
    // shipウィンドウ: エピック単位で「actionable が全て本番待ち」
    const ACTIONABLE = new Set(['要件定義済み', '進行中', 'レビュー待ち', '本番待ち'])
    const byEpic = {}; for (const r of rows) (byEpic[r.epic] ??= []).push(r)
    const shipPages = []
    for (const items of Object.values(byEpic)) {
      const act = items.filter((r) => ACTIONABLE.has(r.status))
      if (act.length && act.every((r) => r.status === '本番待ち')) shipPages.push(...act)
    }

    // ── 初回統合: プルーン後 state が空なら 🧱土台＋レビュー待ち＋要回答 を1通に統合 ──
    if (state.size === 0) {
      const sendSet = []; const seen = new Set()
      for (const it of [...dodaiReview, ...review, ...answers]) { const k = keyOf(it); if (!seen.has(k)) { seen.add(k); sendSet.push(it) } }
      const c = riskCounts(review)
      const dodaiNames = dodaiReview.map((r) => r.title).join('、') || 'なし'
      const ansList = answers.map((r, i) => `${i + 1}.${r.title}`).join(' / ')
      const detail = `【統合ダイジェスト】🧱土台${dodaiReview.length}件[${dodaiNames}] / レビュー待ち${review.length}件(🔴${c.red}🟡${c.yel}🟢${c.grn}) / 判断待ち${answers.length}件${ansList ? '[' + ansList + ']' : ''}。要対応ビュー参照。`.slice(0, 900)
      console.log(`[初回統合メッセージ]\n${detail}`)
      console.log(`[send-set] ${sendSet.length}件 / [prune対象] ${pruned.length}件 ${pruned.length ? '(' + pruned.join(',') + ')' : ''}`)
      if (!DRY) { notify('統合', 'ディスパッチ初回統合', detail); for (const it of sendSet) state.add(keyOf(it)); saveState(state) }
      console.log(`[dispatcher]${DRY ? ' (dry-run)' : ''} 初回統合: send-set ${sendSet.length} / prune ${pruned.length}`)
      return
    }

    // ── 通常トリガー（state 非空）──
    const fired = []
    const newOf = (arr) => arr.filter((r) => !state.has(keyOf(r)))
    // 1) 🧱土台×レビュー待ち（即時・個別・要約＋本文リンク／🧪人力チェック手順は本文）
    for (const it of newOf(dodaiReview)) { notify('🧱土台', it.title, `🧱土台「${it.title}」レビュー待ち。後続が依存。バッチに溜めず今レビュー推奨。🧪人力チェック手順は本文: ${it.url}`); state.add(keyOf(it)); fired.push(keyOf(it)) }
    // max-age flush: 未通知の保留(レビュー待ち＋要回答)の最古経過 > MAX_AGE_H なら閾値未満でもflush
    const now = Date.now()
    const elapsedH = (it) => it.lastEdited ? (now - Date.parse(it.lastEdited)) / 3.6e6 : 0
    const pending = newOf([...review, ...answers])   // state未登録(未通知)分のみ
    const oldestH = pending.length ? Math.max(...pending.map(elapsedH)) : 0
    const maxAgeFlush = pending.length > 0 && oldestH > MAX_AGE_H
    console.log(`[max-age] flush=${maxAgeFlush ? 'Y' : 'N'} 対象${pending.length}件 最古${oldestH.toFixed(1)}h (閾値${MAX_AGE_H}h)`)
    // 2) レビューバッチ（土台以外・閾値 or 🔴≥3 or max-age flush・新規分があれば1通）
    const leaf = review.filter((r) => !r.dodai); const newLeaf = newOf(leaf); const c = riskCounts(leaf)
    if ((leaf.length >= REVIEW_BATCH_THRESH || c.red >= 3 || maxAgeFlush) && newLeaf.length) {
      const why = (maxAgeFlush && leaf.length < REVIEW_BATCH_THRESH && c.red < 3) ? `（max-age flush: 最古${oldestH.toFixed(1)}h>${MAX_AGE_H}h）` : ''
      notify('レビュー可', 'レビューバッチ', `レビュー可: 🔴${c.red}/🟡${c.yel}/🟢${c.grn}（土台以外${leaf.length}件・新規${newLeaf.length}）${why}。要対応ビューへ（各本文に🧪人力チェック手順）。`)
      for (const it of newLeaf) { state.add(keyOf(it)); fired.push(keyOf(it)) }
    }
    // 3) エピックship（エピック単位・リスク内訳付き・新規分のみ）
    //    あるエピックの actionable が全て本番待ち＝ship可。🔴高・🧱土台は本番レビュー対象、🟢はノールック可。
    const newShip = newOf(shipPages)
    if (newShip.length) {
      const shipByEpic = {}
      for (const it of newShip) (shipByEpic[it.epic] ??= []).push(it)
      for (const [epic, items] of Object.entries(shipByEpic)) {
        const cc = riskCounts(items)
        const dodaiN = items.filter((r) => r.dodai).length
        notify('shipクラスタ', epic, `📦エピック「${epic}」ship可: ${items.length}件(🔴${cc.red}/🧱${dodaiN}/🟢${cc.grn})。🔴高・🧱土台は本番レビューしてからship／🟢はノールック可。各本文の🧪人力チェック手順でスモーク・env前提を本番確認。`)
        for (const it of items) { state.add(keyOf(it)); fired.push(keyOf(it)) }
      }
    }
    // 4) 要回答（業務判断）まとめて1通（新規分があれば）
    const newAns = newOf(answers)
    if (newAns.length) {
      notify('判断待ち', `判断待ち${newAns.length}件`, newAns.map((r, i) => `${i + 1}.${r.title}`).join(' / ').slice(0, 280))
      for (const it of newAns) { state.add(keyOf(it)); fired.push(keyOf(it)) }
    }

    console.log(`[send-set] 発火${fired.length}件 / [prune対象] ${pruned.length}件 ${pruned.length ? '(' + pruned.join(',') + ')' : ''}`)
    if (!DRY) saveState(state)
    console.log(`[dispatcher]${DRY ? ' (dry-run)' : ''} 通常: 発火${fired.length} / prune${pruned.length} / レビュー待ち${review.length}(🧱${dodaiReview.length}) 要回答${answers.length}`)
  } finally {
    releaseLock()
  }
}
main().catch((e) => { console.error('✗ dispatcher error:', e); releaseLock(); process.exit(1) })
