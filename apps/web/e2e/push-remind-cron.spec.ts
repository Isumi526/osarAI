import { test, expect } from '@playwright/test';

// DoD項目8(プッシュ通知の自動配信)の恒久テスト。
// /api/cron/remind は Vercel Cron から呼ばれる想定で、共有シークレット(CRON_SECRET)必須(T10#4)。
// 前提: E2E専用インスタンス(3055)にCRON_SECRETが設定されていること。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const CRON_SECRET = process.env.E2E_CRON_SECRET;

test.describe('cron/remind: おさらい促し自動配信', () => {
  test('CRON_SECRETが無い/違うと拒否される', async ({ request }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    const noAuth = await request.get('/api/cron/remind');
    expect(noAuth.status()).toBe(401);

    const wrongAuth = await request.get('/api/cron/remind', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    expect(wrongAuth.status()).toBe(401);
  });

  test('正しいシークレットなら契約中ユーザーのpush_tokenを集計して送信を試みる', async ({ request }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');

    // テストユーザー(契約中=active)+push_tokenを用意
    const email = `e2e-cron-${Date.now()}@example.com`;
    const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
      data: { email, password: 'testpassword123' },
    });
    expect(signupRes.ok()).toBeTruthy();
    const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };

    const subRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
      headers: {
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      data: { user_id: user.id, plan: 'standard', status: 'active' },
    });
    expect(subRes.ok()).toBeTruthy();

    const tokenRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/push_tokens`, {
      headers: {
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
      },
      data: { user_id: user.id, token: `fcm-test-token-${Date.now()}`, platform: 'android' },
    });
    expect(tokenRes.ok()).toBeTruthy();

    const res = await request.get('/api/cron/remind', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { targeted: number; configured: boolean; sent: number; failed: number };
    // 少なくとも今用意した1件は対象に含まれる(他のテストの残骸があっても>=1)
    expect(body.targeted).toBeGreaterThanOrEqual(1);
    // ローカルE2EインスタンスにはFCM_SERVICE_ACCOUNTを設定していないため未設定応答になる
    expect(body.configured).toBe(false);
  });
});
