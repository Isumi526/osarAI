#!/usr/bin/env node
// ============================================================
//  scripts/rls-audit.mjs
//  決定的 RLS / anon 露出監査 — LLM レビューゲートの機械的二重化。
//  pg_catalog / information_schema を SELECT するだけ（書込・DDL 一切なし）。
//
//  使い方:
//    node scripts/rls-audit.mjs                 # 既定=ローカル/shadow(migration適用済) の report
//    node scripts/rls-audit.mjs --assert        # 違反1件でも非ゼロ終了
//    node scripts/rls-audit.mjs --json          # 機械可読
//    node scripts/rls-audit.mjs --prod-readonly # 本番を読取専用接続で監査(SELECTのみ)
//    node scripts/rls-audit.mjs --db-url=<url>  # 接続先を明示上書き
//
//  接続:
//    既定          = ローカル supabase（postgresql://postgres:postgres@127.0.0.1:54322/postgres）
//    --prod-readonly = .env の SUPABASE_PROD_DB_URL（read-only セッション・SELECTのみ）
//    URL は PG* env に分解して psql に渡す（argv/ログに残さない）。
//
//  判定（allowlist=.kody/accepted.yml の rls-multitenant 系 target を「RLSオフ許容」）:
//    🔴 LEAK（--assert 失敗対象）: allowlist外で「anon/public から到達可能」かつ「RLS無効」
//        → anon キーで PostgREST 越しに全行（＝全テナント）読める実害ライン。
//    🟡 WARN（report のみ・assert は失敗させない）:
//        - allowlist外で RLS無効だが anon 到達不可（service_role等のみ）
//        - allowlist外で anon到達可だが RLS有効＝ポリシーで行フィルタ済（supabaseの通常形）
//    ※ supabase は public 表へ anon に既定 grant を撒くため「anon grant有」単独は実害でない。
//      実害は「anon到達可 × RLS無効」。よって assert はこの積で判定し、両次元は report に必ず出す。
// ============================================================

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const getOpt = (k) => { const a = argv.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : null }

const ASSERT = has('--assert')
const JSON_ONLY = has('--json')
const PROD = has('--prod-readonly')
const DB_URL_OVERRIDE = getOpt('--db-url')
const LOCAL_DEFAULT = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// ---- .env 読み（値はログに出さない）----
function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* .env 無しでも override/local で動く */ }
  return env
}

// ---- 接続先決定（URL は PG* env に分解＝argv に出さない）----
function resolveConn(env) {
  let url, label, readOnly
  if (DB_URL_OVERRIDE) { url = DB_URL_OVERRIDE; label = 'override'; readOnly = PROD }
  else if (PROD) {
    url = env.SUPABASE_PROD_DB_URL
    if (!url) { console.error('✗ --prod-readonly だが .env に SUPABASE_PROD_DB_URL が無い'); process.exit(2) }
    label = 'PROD(read-only)'; readOnly = true
  } else { url = LOCAL_DEFAULT; label = 'local(54322)'; readOnly = false }

  let u
  try { u = new URL(url) } catch { console.error('✗ DB URL の形式が不正'); process.exit(2) }
  const pgEnv = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    PGCONNECT_TIMEOUT: '10',
    // read-only は二重防御：セッションを read-only に固定（万一の書込を物理拒否）
    ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}),
  }
  if (u.searchParams.get('sslmode')) pgEnv.PGSSLMODE = u.searchParams.get('sslmode')
  return { pgEnv, label, readOnly }
}

function psqlJson(pgEnv, sql) {
  let out
  try {
    out = execFileSync('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      env: { ...process.env, ...pgEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().split('\n').filter(Boolean).slice(-3).join(' ')
    console.error(`✗ psql 失敗: ${msg}`)
    process.exit(2)
  }
  try { return JSON.parse(out.trim() || '[]') } catch { console.error('✗ 監査クエリの JSON 解析失敗'); process.exit(2) }
}

// ---- allowlist（既存 accepted.yml を流用＝判定源を共有）----
function loadAllowlist() {
  // rls-multitenant 系ルールの target を「RLSオフ許容」テーブルとして拾う。
  // accepted.yml の素朴パース（entries: - rule / target / reason / ticket）。
  const set = new Map() // target -> {reason, ticket}
  let text
  try { text = readFileSync(join(ROOT, '.kody', 'accepted.yml'), 'utf8') } catch { return set }
  const lines = text.split('\n')
  let cur = null
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    const mItem = line.match(/^\s*-\s*rule:\s*(.+?)\s*$/)
    if (mItem) { cur = { rule: strip(mItem[1]) }; continue }
    if (!cur) continue
    const mt = line.match(/^\s*target:\s*(.+?)\s*$/); if (mt) cur.target = strip(mt[1])
    const mr = line.match(/^\s*reason:\s*(.+?)\s*$/); if (mr) cur.reason = strip(mr[1])
    const mk = line.match(/^\s*ticket:\s*(.+?)\s*$/); if (mk) cur.ticket = strip(mk[1])
    if (cur.rule && cur.target && /rls-multitenant/.test(cur.rule)) {
      set.set(cur.target, { reason: cur.reason || '', ticket: cur.ticket || '' })
    }
  }
  return set
  function strip(s) { return s.replace(/^["']|["']$/g, '').trim() }
}

const AUDIT_SQL = `
with tbls as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
pol as ( select polrelid, count(*) n from pg_policy group by polrelid ),
g as (
  select table_name, grantee, string_agg(distinct privilege_type, ',' order by privilege_type) privs
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','PUBLIC')
  group by table_name, grantee
)
select coalesce(json_agg(json_build_object(
  'table', t.relname,
  'rls', t.relrowsecurity,
  'policies', coalesce(p.n, 0),
  'anon', (select privs from g where g.table_name = t.relname and g.grantee = 'anon'),
  'pub',  (select privs from g where g.table_name = t.relname and g.grantee = 'PUBLIC')
) order by t.relname), '[]'::json)
from tbls t left join pol p on p.polrelid = t.oid;
`

function classify(rows, allow) {
  const out = []
  for (const r of rows) {
    const anonReachable = !!(r.anon || r.pub)
    const allowed = allow.has(r.table)
    let level = 'ok', reason = ''
    if (!r.rls && anonReachable) { level = 'leak'; reason = 'anon到達可 × RLS無効（全テナント読取の恐れ）' }
    else if (!r.rls) { level = 'warn'; reason = 'RLS無効（anon到達不可・service_role等のみ）' }
    else if (anonReachable && r.policies === 0) { level = 'warn'; reason = 'RLS有効だがポリシー0件（実質deny-all／要確認）' }
    if (allowed && level !== 'ok') { reason = `allowlist許容: ${allow.get(r.table).reason || ''}`.trim() }
    out.push({ ...r, anonReachable, allowed, level, reason })
  }
  return out
}

// ---- 実行 ----
const env = loadEnv()
const { pgEnv, label } = resolveConn(env)
const allow = loadAllowlist()
const rows = psqlJson(pgEnv, AUDIT_SQL)
const classified = classify(rows, allow)

const leaks = classified.filter((r) => r.level === 'leak' && !r.allowed)
const warns = classified.filter((r) => r.level === 'warn' && !r.allowed)
const allowedHits = classified.filter((r) => r.allowed && r.level !== 'ok')

const summary = {
  target: label,
  total: classified.length,
  violations: leaks.length,
  warnings: warns.length,
  allowlisted: allowedHits.length,
  verdict: leaks.length === 0 ? 'pass' : 'block',
  leaks: leaks.map((r) => ({ table: r.table, rls: r.rls, anon: r.anon, pub: r.pub, reason: r.reason })),
  warns: warns.map((r) => ({ table: r.table, rls: r.rls, anon: r.anon, reason: r.reason })),
  allowlisted_hits: allowedHits.map((r) => ({ table: r.table, reason: r.reason })),
  tables: classified.map((r) => ({ table: r.table, rls: r.rls, policies: r.policies, anon: r.anon || null, pub: r.pub || null, level: r.allowed ? 'allow' : r.level })),
}

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
} else {
  const mark = (r) => r.allowed ? '⚪allow' : r.level === 'leak' ? '🔴LEAK' : r.level === 'warn' ? '🟡warn' : '🟢ok'
  console.log(`\n📋 RLS/anon 監査 — ${label}  (public 表 ${summary.total}件)`)
  console.log('─'.repeat(78))
  console.log(['  状態', 'テーブル'.padEnd(28), 'RLS', 'pol', 'anon/public grant'].join(' '))
  for (const r of classified) {
    const grant = [r.anon ? `anon:${r.anon}` : null, r.pub ? `PUBLIC:${r.pub}` : null].filter(Boolean).join(' ') || '—'
    console.log(['  ' + mark(r).padEnd(7), r.table.padEnd(28), (r.rls ? 'on ' : 'OFF'), String(r.policies).padStart(2) + ' ', grant].join(' '))
  }
  console.log('─'.repeat(78))
  console.log(`🔴 LEAK(違反): ${leaks.length}　🟡 warn: ${warns.length}　⚪ allowlist許容: ${allowedHits.length}`)
  if (leaks.length) {
    console.log('\n🔴 違反（allowlist外・anon到達可×RLS無効）:')
    for (const r of leaks) console.log(`   - ${r.table} … ${r.reason}`)
  }
  if (warns.length) {
    console.log('\n🟡 warn（report のみ・assert非対象）:')
    for (const r of warns) console.log(`   - ${r.table} … ${r.reason}`)
  }
  if (allowedHits.length) {
    console.log('\n⚪ allowlist で許容中（accepted.yml で追跡）:')
    for (const r of allowedHits) console.log(`   - ${r.table} … ${r.reason}`)
  }
  console.log(`\nverdict: ${summary.verdict}\n`)
}

if (ASSERT && leaks.length > 0) process.exit(1)
process.exit(0)
