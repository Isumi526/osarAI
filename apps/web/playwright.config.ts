import { defineConfig, devices } from '@playwright/test';

// 最小構成（DECISIONS T11: テスト＝実行可能な仕様）。
// 対象は課金/webhook系の恒久回帰（Stripe課金負債台帳 A1-A5）。
// dev server は各自 `pnpm dev:web` で起動済み・local Supabase (`supabase start`) 起動済み前提。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // 複数specが同一の固定ローカルポート(mock humanballサーバー等)を使うため、
  // クロスファイル並列も止めて完全直列にする(ポート競合防止)。
  workers: 1,
  retries: 0,
  reporter: 'list',
  // next dev の初回コンパイル(route単位)やStripeホスト側ページの読み込みでばらつくため既定30sでは不安定。
  timeout: 60_000,
  use: {
    // NOTE: 既定は3000ではなくlocal Supabase向けの専用インスタンス。
    // `pnpm dev:web`(3000)は.env.local経由でホスト型Supabaseに繋がっており、
    // signup等の書き込みテストを本番化しうる環境に向けたくないため分離する。
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3055',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
