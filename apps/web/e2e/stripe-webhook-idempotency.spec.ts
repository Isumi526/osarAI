import http from 'node:http';
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

// Stripe課金負債台帳 A2 の恒久回帰: webhookにイベント冪等化・順序ガードが
// 無かった問題。(1) 同一event.idの再送は二重適用/二重通知しないこと
// (2) 順序逆転(古いイベントが後着)で新しい状態を巻き戻さないことを確認する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const LOCAL_SERVICE_ROLE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const WEBHOOK_SECRET = 'whsec_e2e_test_secret';
const MOCK_HUMANBALL_PORT = 3999;

async function signup(request: import('@playwright/test').APIRequestContext, email: string) {
  const res = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { user: { id: string }; access_token: string };
}

test.describe('A2: webhook 冪等化・順序ガード', () => {
  test('同一event.idの再送は二重通知しない', async ({ request }) => {
    const received: unknown[] = [];
    const mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          received.push(JSON.parse(body));
        } catch {
          received.push(body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(MOCK_HUMANBALL_PORT, resolve));

    try {
      const fakeEvent = {
        id: `evt_e2e_a2_dup_${Date.now()}`,
        object: 'event',
        type: 'invoice.payment_failed',
        data: {
          object: { id: `in_e2e_a2_${Date.now()}`, object: 'invoice', subscription: null, customer: 'cus_fake' },
        },
      };
      const payload = JSON.stringify(fakeEvent);
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

      const res1 = await request.post('/api/stripe/webhook', {
        data: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
      });
      expect(res1.ok()).toBeTruthy();
      expect(await res1.json()).toEqual({ received: true });

      // 同一event.idを再送(Stripeの再送を模す)
      const res2 = await request.post('/api/stripe/webhook', {
        data: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
      });
      expect(res2.ok()).toBeTruthy();
      expect(await res2.json()).toEqual({ received: true, duplicate: true });

      // 通知は1回だけ(二重送信されていない)
      await expect.poll(() => received.length, { timeout: 5000 }).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1000)); // 万一の二重配信を拾うための猶予
      expect(received).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  test('順序逆転したイベントは新しい状態を巻き戻さない', async ({ request }) => {
    const email = `e2e-a2-order-${Date.now()}@example.com`;
    const { user, access_token: userAccessToken } = await signup(request, email);
    const fakeSubId = `sub_e2e_a2_${Date.now()}`;

    const upsertRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
      headers: {
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${userAccessToken}`,
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      data: { user_id: user.id, stripe_subscription_id: fakeSubId, plan: 'standard', status: 'active' },
    });
    expect(upsertRes.ok()).toBeTruthy();

    const now = Math.floor(Date.now() / 1000);
    const newerEvent = {
      id: `evt_e2e_a2_newer_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: now,
      data: {
        object: {
          id: fakeSubId,
          object: 'subscription',
          status: 'active',
          trial_end: null,
          current_period_end: now + 30 * 24 * 3600,
          items: { data: [{ price: { id: process.env.E2E_STRIPE_PRICE_PRO } }] },
        },
      },
    };
    const olderEvent = {
      id: `evt_e2e_a2_older_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: now - 3600, // 1時間前(順序逆転して後から届いた古いイベント)
      data: {
        object: {
          id: fakeSubId,
          object: 'subscription',
          status: 'active',
          trial_end: null,
          current_period_end: now + 30 * 24 * 3600,
          items: { data: [{ price: { id: process.env.E2E_STRIPE_PRICE_LIGHT } }] },
        },
      },
    };
    test.skip(
      !process.env.E2E_STRIPE_PRICE_PRO || !process.env.E2E_STRIPE_PRICE_LIGHT,
      'E2E_STRIPE_PRICE_* 未設定のためスキップ',
    );

    // 先に新しい方(Pro)を適用 → 後から古い方(Light)が届いても巻き戻らないこと
    for (const ev of [newerEvent, olderEvent]) {
      const payload = JSON.stringify(ev);
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
      const res = await request.post('/api/stripe/webhook', {
        data: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
      });
      expect(res.ok()).toBeTruthy();
    }

    const readRes = await request.get(
      `${LOCAL_SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${fakeSubId}&select=plan`,
      { headers: { apikey: LOCAL_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` } },
    );
    expect(readRes.ok()).toBeTruthy();
    const rows = (await readRes.json()) as { plan: string }[];
    expect(rows[0]!.plan).toBe('pro'); // 古いLightイベントに巻き戻っていないこと
  });
});
