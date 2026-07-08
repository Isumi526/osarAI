import http from 'node:http';
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

// Stripe課金負債台帳 A3 の恒久回帰: 自動課金失敗(invoice.payment_failed)を
// 放置していた問題。(1) webhookが運営者通知を発火すること (2) /billing に
// past_due の再決済導線(Stripe Billing Portal)が出ることを確認する。
//
// 前提: local Supabase(`supabase start`) + E2E専用の web インスタンス(3055)が
// `HUMANBALL_WEBHOOK_URL` をこのテスト用モックサーバーへ向けて起動されていること
// （実LINE通知を毎回のテスト実行で鳴らさないため）。詳細は SHIP_STATE.md。
//
// 注意: このローカルGoTrueビルドは `auth.admin.*`（管理API）に既知の不具合があり
// （HS256 JWT検証で新旧どちらのキー形式でも 403 bad_jwt になる）、テストユーザー作成は
// 通常のsignupエンドポイント + ログインUIを使う（本番のGoTrueには影響しない、ローカル限定の地雷）。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const MOCK_HUMANBALL_PORT = 3999;

test.describe('A3: 自動課金失敗ハンドリング', () => {
  test('invoice.payment_failed で運営者通知が発火し、/billing に再決済導線が出る', async ({ page, request }) => {
    test.setTimeout(90_000); // signup+webhook+ログインUI+Stripeポータル遷移を1テストで直列に確認するため既定30sでは足りない
    const stripeSecret = process.env.E2E_STRIPE_SECRET_KEY;
    test.skip(!stripeSecret, 'E2E_STRIPE_SECRET_KEY 未設定のためスキップ');
    const stripe = new Stripe(stripeSecret!);

    // --- モック運営者通知サーバー(実LINEは鳴らさない) ---
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

    let stripeCustomerId: string | null = null;
    try {
      // --- テストユーザーを通常のsignupエンドポイントで作成(local autoconfirm) ---
      const email = `e2e-a3-${Date.now()}@example.com`;
      const password = 'testpassword123';
      const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
        headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
        data: { email, password },
      });
      expect(signupRes.ok()).toBeTruthy();
      const signupJson = (await signupRes.json()) as { access_token: string; user: { id: string } };
      const userId = signupJson.user.id;
      const userAccessToken = signupJson.access_token;

      // --- Stripe test customer + subscriptions行(past_due)を用意 ---
      // subscriptions行の書き込みはRLS`subs_own`により本人トークンで可能(サービスロール不要)。
      const customer = await stripe.customers.create({ email });
      stripeCustomerId = customer.id;
      const fakeSubId = `sub_e2e_${Date.now()}`;
      const upsertRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
        headers: {
          apikey: LOCAL_ANON_KEY,
          Authorization: `Bearer ${userAccessToken}`,
          'content-type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        data: {
          user_id: userId,
          stripe_customer_id: customer.id,
          stripe_subscription_id: fakeSubId,
          plan: 'standard',
          status: 'past_due',
        },
      });
      expect(upsertRes.ok()).toBeTruthy();

      // --- invoice.payment_failed を模した署名付きイベントをwebhookへPOST ---
      const fakeEvent = {
        id: `evt_e2e_${Date.now()}`,
        object: 'event',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: `in_e2e_${Date.now()}`,
            object: 'invoice',
            subscription: fakeSubId,
            customer: customer.id,
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

      // --- 運営者通知が飛んだことを確認(モック側で受信) ---
      await expect.poll(() => received.length, { timeout: 5000 }).toBeGreaterThan(0);
      const notif = received[0] as { kind?: string; task?: string; detail?: string };
      expect(notif.kind).toBe('要対応');
      expect(notif.task).toContain('自動課金 失敗');
      expect(notif.detail).toContain(userId);

      // --- /billing に再決済導線(past_due banner + ポータル遷移)が出ることを確認 ---
      await page.goto('/login');
      await page.getByPlaceholder('メールアドレス').fill(email);
      await page.getByPlaceholder('パスワード').fill(password);
      await page.getByRole('button', { name: 'ログイン' }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 15000 });
      await page.goto('/billing');
      await expect(page.getByText('自動課金に失敗しています')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: 'お支払い方法を更新する' }).click();
      // Stripeホスト側ページの完全ロード完了までは待たない(ネットワーク活動が続き'load'待ちが不安定)。
      // 遷移先URLが確定した時点(commit)でポータルセッションが作られたことは確認できる。
      await page.waitForURL(/billing\.stripe\.com/, { timeout: 15000, waitUntil: 'commit' });
      expect(page.url()).toContain('billing.stripe.com');
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      if (stripeCustomerId) {
        const stripe2 = new Stripe(stripeSecret!);
        await stripe2.customers.del(stripeCustomerId).catch(() => {});
      }
    }
  });
});
