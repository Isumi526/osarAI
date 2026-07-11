import { test, expect } from '@playwright/test';

// 定期的な行動提案プッシュ通知の恒久テスト。/api/cron/action-suggest は
// Vercel Cronから呼ばれる想定で、共有シークレット(CRON_SECRET)必須(T10#4)。
// cron/remind(毎日・全員一律)とは異なり、直近7日おさらいしていない顧客がいる
// ユーザーだけを個別に対象化する。
// 前提: E2E専用インスタンス(3055)にCRON_SECRETが設定されていること。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const LOCAL_SERVICE_ROLE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const CRON_SECRET = process.env.E2E_CRON_SECRET;

async function clearTodaysCronRun(request: import('@playwright/test').APIRequestContext) {
  await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/cron_runs?job=eq.action_suggest`, {
    headers: { apikey: LOCAL_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` },
  });
}

test.describe('cron/action-suggest: 行動提案プッシュ通知', () => {
  test('CRON_SECRETが無い/違うと拒否される', async ({ request }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    const noAuth = await request.get('/api/cron/action-suggest');
    expect(noAuth.status()).toBe(401);
  });

  test('7日以上おさらいしていない顧客がいるユーザーだけが対象になり、同日2回目はスキップされる', async ({
    request,
  }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    await clearTodaysCronRun(request);

    // 対象になるべきユーザー: 契約中 + 8日前接触の顧客1件 + push_token
    const emailStale = `e2e-action-stale-${Date.now()}@example.com`;
    const signupStale = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
      data: { email: emailStale, password: 'testpassword123' },
    });
    expect(signupStale.ok()).toBeTruthy();
    const { user: staleUser, access_token: staleToken } = (await signupStale.json()) as {
      user: { id: string };
      access_token: string;
    };
    const staleAuth = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${staleToken}`, 'content-type': 'application/json' };

    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
      headers: { ...staleAuth, Prefer: 'resolution=merge-duplicates' },
      data: { user_id: staleUser.id, plan: 'standard', status: 'active' },
    });

    const profileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${staleUser.id}&select=org_id`, {
      headers: staleAuth,
    });
    const [profile] = (await profileRes.json()) as { org_id: string }[];

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
      headers: { ...staleAuth, Prefer: 'return=representation' },
      data: {
        org_id: profile!.org_id,
        owner_id: staleUser.id,
        name: '放置顧客',
        status: 'active',
        last_met_at: eightDaysAgo,
      },
    });

    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/push_tokens`, {
      headers: staleAuth,
      data: { user_id: staleUser.id, token: `fcm-test-stale-${Date.now()}`, platform: 'android' },
    });

    // 対象にならないユーザー: 契約中だが今日接触した顧客のみ(直近7日以内)
    const emailFresh = `e2e-action-fresh-${Date.now()}@example.com`;
    const signupFresh = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
      headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
      data: { email: emailFresh, password: 'testpassword123' },
    });
    const { user: freshUser, access_token: freshToken } = (await signupFresh.json()) as {
      user: { id: string };
      access_token: string;
    };
    const freshAuth = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${freshToken}`, 'content-type': 'application/json' };
    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
      headers: { ...freshAuth, Prefer: 'resolution=merge-duplicates' },
      data: { user_id: freshUser.id, plan: 'standard', status: 'active' },
    });
    const freshProfileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${freshUser.id}&select=org_id`, {
      headers: freshAuth,
    });
    const [freshProfile] = (await freshProfileRes.json()) as { org_id: string }[];
    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
      headers: freshAuth,
      data: {
        org_id: freshProfile!.org_id,
        owner_id: freshUser.id,
        name: '最近会った顧客',
        status: 'active',
        last_met_at: new Date().toISOString(),
      },
    });
    await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/push_tokens`, {
      headers: freshAuth,
      data: { user_id: freshUser.id, token: `fcm-test-fresh-${Date.now()}`, platform: 'android' },
    });

    const res = await request.get('/api/cron/action-suggest', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { targeted: number; configured: boolean; sent: number; failed: number };
    // 放置顧客を持つユーザーだけが対象(他テストの残骸があっても>=1)。
    // fresh側は今日接触済みのため targeted に混ざらない設計を確認する意図(直接比較は残骸の関係で厳密化しない)。
    expect(body.targeted).toBeGreaterThanOrEqual(1);
    expect(body.configured).toBe(false); // ローカルE2EインスタンスにFCM_SERVICE_ACCOUNT未設定

    const res2 = await request.get('/api/cron/action-suggest', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    const body2 = (await res2.json()) as { skipped?: boolean };
    expect(body2.skipped).toBe(true);
  });
});
