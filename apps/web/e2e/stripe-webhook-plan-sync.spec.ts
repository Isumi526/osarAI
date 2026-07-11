import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

// Stripe課金負債台帳 A1 の恒久回帰: customer.subscription.updated/deleted が
// status/trial_end/current_period_end のみ同期し plan を同期していなかった問題。
// プラン変更(アップグレード/ダウングレード)がDBへ反映されず、entitlementが
// 旧プランのままゲートし続けるバグを再現・回帰確認する。
//
// 前提: E2E専用インスタンス(3055・local Supabase・STRIPE_WEBHOOK_SECRET=whsec_e2e_test_secret)。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const LOCAL_SERVICE_ROLE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

test('customer.subscription.updated でplanの変更がDBへ同期される(A1)', async ({ request }) => {
  test.setTimeout(60_000);
  const stripePriceStandard = process.env.E2E_STRIPE_PRICE_STANDARD;
  const stripePriceLight = process.env.E2E_STRIPE_PRICE_LIGHT;
  test.skip(!stripePriceStandard || !stripePriceLight, 'E2E_STRIPE_PRICE_* 未設定のためスキップ');

  // --- テストユーザー + 初期状態(standard)のsubscriptions行を用意 ---
  const email = `e2e-a1-${Date.now()}@example.com`;
  const password = 'testpassword123';
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token: userAccessToken } = (await signupRes.json()) as {
    user: { id: string };
    access_token: string;
  };
  const userId = user.id;

  const fakeSubId = `sub_e2e_a1_${Date.now()}`;
  const upsertRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: {
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${userAccessToken}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    data: {
      user_id: userId,
      stripe_subscription_id: fakeSubId,
      plan: 'standard',
      status: 'active',
    },
  });
  expect(upsertRes.ok()).toBeTruthy();

  // --- customer.subscription.updated（Standard→Lightへダウングレード）を模した署名付きイベント ---
  const fakeEvent = {
    id: `evt_e2e_a1_${Date.now()}`,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: fakeSubId,
        object: 'subscription',
        status: 'active',
        trial_end: null,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        items: { data: [{ price: { id: stripePriceLight } }] },
      },
    },
  };
  const payload = JSON.stringify(fakeEvent);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_e2e_test_secret' });

  const whRes = await request.post('/api/stripe/webhook', {
    data: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
  });
  expect(whRes.ok()).toBeTruthy();
  expect(await whRes.json()).toEqual({ received: true });

  // --- DBのplanがlightに同期されたことを確認(修正前はstandardのまま=バグ再現) ---
  const readRes = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${fakeSubId}&select=plan,status`,
    { headers: { apikey: LOCAL_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` } },
  );
  expect(readRes.ok()).toBeTruthy();
  const rows = (await readRes.json()) as { plan: string; status: string }[];
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.plan).toBe('light');
  expect(row.status).toBe('active');
});
