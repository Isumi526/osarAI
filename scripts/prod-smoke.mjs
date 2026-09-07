// ============================================================
//  scripts/prod-smoke.mjs
//  本番スモーク（読み取り専用）。1日1回まわして、壊れていたら開発者に通知する。
//
//  契機: モデル更新でおさらいのAIが本番で動かなくなり、気づくのが遅れたこと。
//  「本番が生きているか」「認可ガードが効いているか」「AIが応答するか」だけを見る。
//
//  ★書き込みは一切しない（GETのみ）。本番にテストデータを作らない。
//
//  使い方:
//    node scripts/prod-smoke.mjs             # 実行して失敗時に通知
//    node scripts/prod-smoke.mjs --dry-run   # 通知しない（結果を出すだけ）
//
//  env(.env or CI secrets):
//    PROD_WEB_URL     … 既定 https://osarai.app
//    PROD_MOBILE_URL  … 既定 https://app.osarai.app
//    SMOKE_TOKEN      … /api/health/ai を叩くトークン（未設定ならAI疎通チェックはskip）
//    HUMANBALL_WEBHOOK_URL / HUMANBALL_WEBHOOK_SECRET / NOTIFY_PREFIX … 通知（notify-humanball.mjs が使う）
// ============================================================
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.slice(2).includes('--dry-run');

function loadEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* CI では .env が無い＝process.env を使う */ }
  return out;
}
const env = { ...loadEnv(resolve(ROOT, '.env')), ...process.env };

const WEB = (env.PROD_WEB_URL || 'https://osarai.app').replace(/\/$/, '');
const MOBILE = (env.PROD_MOBILE_URL || 'https://app.osarai.app').replace(/\/$/, '');
const SMOKE_TOKEN = env.SMOKE_TOKEN || '';
const TIMEOUT_MS = 20_000;

async function get(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal, redirect: 'manual' });
    return { status: res.status, ms: Date.now() - t0, body: await res.text().catch(() => '') };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: '', error: String(e instanceof Error ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 1) Web が生きているか（リダイレクトも生存とみなす）
{
  const r = await get(`${WEB}/`);
  record('web top', r.status >= 200 && r.status < 400, `HTTP ${r.status} (${r.ms}ms)${r.error ? ` ${r.error}` : ''}`);
}

// 2) ヘルスエンドポイント
{
  const r = await get(`${WEB}/api/health`);
  let ok = r.status === 200;
  if (ok) { try { ok = JSON.parse(r.body).ok === true; } catch { ok = false; } }
  record('web /api/health', ok, `HTTP ${r.status} (${r.ms}ms)`);
}

// 3) 認可ガード: 認証/秘密鍵が要るエンドポイントが、未認証で 401 を返すこと。
//    ここが 2xx になったら素通し＝顧客データが読める / cron を誰でも叩けて
//    全ユーザーに通知が飛ぶ、という事故。可用性より優先して気づきたい。
for (const path of ['/api/referral-codes', '/api/cron/remind', '/api/cron/action-suggest']) {
  const r = await get(`${WEB}${path}`);
  const ok = r.status === 401 || r.status === 403;
  record(`認可ガード ${path}`, ok, `HTTP ${r.status}${r.status >= 200 && r.status < 300 ? ' ← 未認証で成功している' : ''}`);
}

// 4) モバイル(Web配信)が生きているか
{
  const r = await get(`${MOBILE}/`);
  record('mobile top', r.status >= 200 && r.status < 400, `HTTP ${r.status} (${r.ms}ms)${r.error ? ` ${r.error}` : ''}`);
}

// 5) AI(Gemini)疎通。トークン未設定ならskip（落とさない）。
if (SMOKE_TOKEN) {
  const r = await get(`${WEB}/api/health/ai`, { 'x-smoke-token': SMOKE_TOKEN });
  record('AI(Gemini)疎通', r.status === 200, `HTTP ${r.status} (${r.ms}ms) ${r.body.slice(0, 120)}`);
} else {
  console.log('- AI(Gemini)疎通 — skip (SMOKE_TOKEN 未設定)');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[prod-smoke] ${results.length - failed.length}/${results.length} ok`);

if (failed.length === 0) process.exit(0);

const detail =
  `本番スモークで${failed.length}件失敗:\n` +
  failed.map((f) => `・${f.name}（${f.detail}）`).join('\n') +
  `\n自動修正: 不可（本番の状態確認が先。デプロイ直後ならロールバックを検討）`;

if (DRY) {
  console.log(`\n(dry-run) 通知内容:\n${detail}`);
  process.exit(1);
}

const r = spawnSync(
  'node',
  [resolve(ROOT, 'scripts/notify-humanball.mjs'), '--kind', '本番異常', '--task', '本番スモーク失敗', '--detail', detail],
  { stdio: 'inherit' },
);
process.exit(r.status === 0 ? 1 : 1);
