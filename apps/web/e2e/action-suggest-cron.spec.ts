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

type Auth = Record<string, string>;
async function newActiveUser(request: import('@playwright/test').APIRequestContext, prefix: string) {
  const r = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'testpassword123' },
  });
  expect(r.ok()).toBeTruthy();
  const { user, access_token } = (await r.json()) as { user: { id: string }; access_token: string };
  const auth: Auth = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: { ...auth, Prefer: 'resolution=merge-duplicates' },
    data: { user_id: user.id, plan: 'standard', status: 'active' },
  });
  const [p] = (await (await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=org_id`, { headers: auth })).json()) as { org_id: string }[];
  return { id: user.id, orgId: p!.org_id, auth };
}
async function restInsert(request: import('@playwright/test').APIRequestContext, auth: Auth, table: string, data: Record<string, unknown>) {
  const r = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/${table}`, { headers: { ...auth, Prefer: 'return=representation' }, data });
  expect(r.ok(), `${table}: ${await r.text()}`).toBeTruthy();
  return ((await r.json()) as { id: string }[])[0]!;
}
async function myNotifications(request: import('@playwright/test').APIRequestContext, auth: Auth) {
  const r = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?select=title,body,link_path`, { headers: auth });
  return (await r.json()) as { title: string; body: string | null; link_path: string | null }[];
}

async function clearTodaysCronRun(request: import('@playwright/test').APIRequestContext) {
  await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/cron_runs?job=eq.action_suggest`, {
    headers: { apikey: LOCAL_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` },
  });
}

test.describe('cron/action-suggest: 週1の返事待ち通知', () => {
  test('CRON_SECRETが無い/違うと拒否される', async ({ request }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    const noAuth = await request.get('/api/cron/action-suggest');
    expect(noAuth.status()).toBe(401);
  });

  test('相手待ちが期限切れ／期限なしで1週間たった人にだけ「返事待ち」が届き、ベルにも残る。同日2回目はスキップ', async ({
    request,
  }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    await clearTodaysCronRun(request);

    const a = await newActiveUser(request, 'e2e-waiting-a');
    const b = await newActiveUser(request, 'e2e-waiting-b');
    const cust = await restInsert(request, a.auth, 'customers', { org_id: a.orgId, owner_id: a.id, name: '返事待ち花子', status: 'active' });
    // A: 期限を過ぎた相手待ち
    await restInsert(request, a.auth, 'tasks', {
      org_id: a.orgId,
      owner_id: a.id,
      customer_id: cust.id,
      title: '見積もりを送る',
      due_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
      assignee: 'other',
    });
    // B: 自分のTODOだけ（相手待ちではないので対象外）
    await restInsert(request, b.auth, 'tasks', {
      org_id: b.orgId,
      owner_id: b.id,
      title: '資料を送る',
      due_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
      assignee: 'self',
    });

    const res = await request.get('/api/cron/action-suggest', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { targeted: number; configured: boolean };
    expect(body.targeted).toBeGreaterThanOrEqual(1);
    expect(body.configured).toBe(false); // ローカルE2EインスタンスにFCM_SERVICE_ACCOUNT未設定

    const notesA = await myNotifications(request, a.auth);
    expect(notesA.some((n) => n.title === '返事待ちが1件あります' && (n.body ?? '').includes('「見積もりを送る」（返事待ち花子さん）'))).toBe(true);
    expect(await myNotifications(request, b.auth)).toHaveLength(0);

    const res2 = await request.get('/api/cron/action-suggest', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(((await res2.json()) as { skipped?: boolean }).skipped).toBe(true);
  });
});
