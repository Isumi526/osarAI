// ============================================================
//  scripts/staging-setup.mjs — ステージング環境の構築（2026-09-21）
//
//  本番（osarai.app / app.osarai.app / Supabase apiagxfbazxmdqcbynxk）とは完全に分離した
//  検証環境を、Supabase staging プロジェクト ＋ Vercel Preview デプロイで作る。
//  iPhone 実機（HTTPS 必須）や 60 分会議の Vercel 上限の再現に使う。
//
//  前提: `.env.staging.local`（.env.staging.local.example をコピーして値を貼る・gitignore 対象）
//        Vercel CLI ログイン済み・apps/web/.vercel, apps/mobile/.vercel にプロジェクトリンク済み・psql あり
//
//  使い方: node scripts/staging-setup.mjs [--step migrate|env|deploy|seed|all] [--dry-run]
//    migrate … staging DB に supabase/migrations/*.sql を順に適用（1トランザクション・schema_migrations 記録）
//    env     … Vercel の Preview 環境変数を web/mobile に設定（既存の同名は置き換え）
//    deploy  … web → mobile の順に preview デプロイし、固定エイリアスを付ける
//    seed    … staging にテストユーザー（Light/trialing）を作る
//  安全装置: staging の URL/DB URL に本番 ref が含まれていたら即停止。--prod は付けない（preview のみ）。
// ============================================================
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const PROD_REF = 'apiagxfbazxmdqcbynxk';
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STEP = val('--step', 'all');
const DRY = argv.includes('--dry-run');

function loadEnv(p) {
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const S = loadEnv(resolve(ROOT, '.env.staging.local'));
const need = (k) => { if (!S[k]) throw new Error(`.env.staging.local に ${k} がありません`); return S[k]; };

// --- 安全装置 ---
for (const k of ['STAGING_SUPABASE_URL', 'STAGING_SUPABASE_DB_URL']) {
  if ((S[k] ?? '').includes(PROD_REF)) { console.error(`✗ ${k} が本番プロジェクトを指しています。中止。`); process.exit(1); }
}
if ((S.STAGING_STRIPE_SECRET_KEY ?? '').startsWith('sk_live')) { console.error('✗ Stripe が live キーです。staging はテストモード(sk_test_)のみ。'); process.exit(1); }

const webAlias = S.STAGING_WEB_ALIAS || '';
const mobileAlias = S.STAGING_MOBILE_ALIAS || '';
const webUrl = webAlias ? `https://${webAlias}` : null;
const mobileUrl = mobileAlias ? `https://${mobileAlias}` : null;

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd.replace(/(sk_test_|sb_secret_|eyJ)[A-Za-z0-9._-]+/g, '$1***')}`);
  if (DRY) return '';
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }).trim();
}
function vercelIds(app) {
  const j = JSON.parse(readFileSync(resolve(ROOT, `apps/${app}/.vercel/project.json`), 'utf8'));
  return `VERCEL_ORG_ID=${j.orgId} VERCEL_PROJECT_ID=${j.projectId}`;
}

// ---------- migrate ----------
function migrate() {
  const db = need('STAGING_SUPABASE_DB_URL');
  const dir = resolve(ROOT, 'supabase/migrations');
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const applied = DRY ? [] : execSync(`psql "${db}" -Atc "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text); select version from supabase_migrations.schema_migrations;"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const pending = files.filter((f) => !applied.includes(f.slice(0, 4)));
  console.log(`▶ migrations: 適用済み ${applied.length} / 未適用 ${pending.length}`);
  if (!pending.length) return;
  const sql = ['\\set ON_ERROR_STOP on', 'begin;', ...pending.map((f) => `\\i ${join(dir, f)}`),
    ...pending.map((f) => `insert into supabase_migrations.schema_migrations(version, name) values ('${f.slice(0, 4)}', '${f.replace(/\.sql$/, '')}');`),
    'commit;'].join('\n');
  const tmp = join(mkdtempSync(join(tmpdir(), 'osarai-mig-')), 'apply.sql');
  writeFileSync(tmp, sql);
  sh(`psql "${db}" -v ON_ERROR_STOP=1 -f ${tmp}`);
  console.log(`✅ ${pending.length} 本を適用: ${pending.map((f) => f.slice(0, 4)).join(', ')}`);
}

// ---------- env ----------
function setEnv(app, entries) {
  const ids = vercelIds(app);
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined || v === '') continue;
    // 既存の preview 値があれば消してから追加（vercel env add は上書きしない）
    spawnSync('sh', ['-c', `${ids} vercel env rm ${k} preview -y >/dev/null 2>&1 || true`], { cwd: ROOT });
    if (DRY) { console.log(`  [dry] ${app}: ${k}`); continue; }
    const r = spawnSync('sh', ['-c', `${ids} vercel env add ${k} preview`], { cwd: ROOT, input: v, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`vercel env add ${k} (${app}) 失敗: ${r.stderr}`);
    console.log(`  ${app}: ${k} ✓`);
  }
}
function env() {
  const supaUrl = need('STAGING_SUPABASE_URL');
  const anon = need('STAGING_SUPABASE_ANON_KEY');
  console.log('▶ Vercel Preview env (web)');
  setEnv('web', {
    SUPABASE_URL: supaUrl,
    NEXT_PUBLIC_SUPABASE_URL: supaUrl,
    SUPABASE_ANON_KEY: anon,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: need('STAGING_SUPABASE_SERVICE_ROLE_KEY'),
    GEMINI_API_KEY: need('STAGING_GEMINI_API_KEY'),
    STRIPE_SECRET_KEY: need('STAGING_STRIPE_SECRET_KEY'),
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: need('STAGING_STRIPE_PUBLISHABLE_KEY'),
    STRIPE_PRICE_LIGHT: need('STAGING_STRIPE_PRICE_LIGHT'),
    STRIPE_PRICE_STANDARD: S.STAGING_STRIPE_PRICE_STANDARD,
    STRIPE_PRICE_PRO: S.STAGING_STRIPE_PRICE_PRO,
    STRIPE_WEBHOOK_SECRET: S.STAGING_STRIPE_WEBHOOK_SECRET || 'whsec_staging_placeholder',
    NEXT_PUBLIC_APP_URL: mobileUrl ?? undefined,
    NOTIFY_PREFIX: '[osarAI-staging]',
    NOTIFY_PROJECT: 'osarAI',
  });
  console.log('▶ Vercel Preview env (mobile)');
  setEnv('mobile', {
    VITE_SUPABASE_URL: supaUrl,
    VITE_SUPABASE_ANON_KEY: anon,
    VITE_API_BASE_URL: webUrl ?? undefined,
    VITE_LP_ORIGIN: webUrl ?? undefined,
  });
  if (!webUrl) console.log('⚠ STAGING_WEB_ALIAS が無いので VITE_API_BASE_URL は未設定。deploy 後に web の URL を設定して mobile を再デプロイすること');
}

// ---------- deploy ----------
function deploy() {
  // Root Directory がプロジェクト側に設定済みのため、必ずリポジトリルートから ID 指定で実行する（runbook）
  for (const app of ['web', 'mobile']) {
    console.log(`▶ preview deploy: ${app}`);
    const url = sh(`${vercelIds(app)} vercel --yes 2>/dev/null | tail -1`);
    console.log(`  deployment: ${url}`);
    const alias = app === 'web' ? webAlias : mobileAlias;
    if (alias && url) {
      try { sh(`${vercelIds(app)} vercel alias set ${url} ${alias}`); console.log(`  alias: https://${alias}`); }
      catch { console.log(`  ⚠ alias ${alias} を付けられませんでした（名前が使用済みの可能性）。deployment URL を使ってください`); }
    }
  }
}

// ---------- seed ----------
async function seed() {
  const supaUrl = need('STAGING_SUPABASE_URL');
  const anon = need('STAGING_SUPABASE_ANON_KEY');
  const svc = need('STAGING_SUPABASE_SERVICE_ROLE_KEY');
  const email = need('STAGING_TEST_EMAIL');
  const password = need('STAGING_TEST_PASSWORD');
  const name = S.STAGING_TEST_DISPLAY_NAME || 'テスト';
  console.log(`▶ seed test user: ${email}`);
  if (DRY) return;
  let r = await fetch(`${supaUrl}/auth/v1/signup`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, data: { display_name: name } }) });
  let j = await r.json();
  let userId = j.user?.id ?? j.id;
  if (!userId) {
    r = await fetch(`${supaUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    j = await r.json();
    userId = j.user?.id;
    if (!userId) throw new Error(`signup/login 失敗: ${JSON.stringify(j).slice(0, 200)}（メール確認が必要な設定なら Auth > Providers > Email の Confirm email を OFF に）`);
  }
  const svcHdr = { apikey: svc, Authorization: `Bearer ${svc}`, 'content-type': 'application/json' };
  for (let i = 0; i < 10; i++) {
    const p = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${userId}&select=id`, { headers: svcHdr }).then((x) => x.json());
    if (p?.[0]) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const sub = await fetch(`${supaUrl}/rest/v1/subscriptions`, { method: 'POST', headers: { ...svcHdr, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: userId, plan: 'light', status: 'trialing' }) });
  if (!sub.ok) throw new Error(`subscriptions upsert 失敗: ${await sub.text()}`);
  console.log(`✅ user=${userId} plan=light status=trialing`);
}

const steps = STEP === 'all' ? ['migrate', 'env', 'deploy', 'seed'] : [STEP];
for (const st of steps) {
  if (st === 'migrate') migrate();
  else if (st === 'env') env();
  else if (st === 'deploy') deploy();
  else if (st === 'seed') await seed();
  else { console.error(`不明な step: ${st}`); process.exit(1); }
}
console.log(`\n完了。web: ${webUrl ?? '(deployment URL)'} / mobile: ${mobileUrl ?? '(deployment URL)'}`);
