import { test, expect } from '@playwright/test';

// DoD項目8(プッシュ通知の自動配信)の恒久テスト。
// /api/cron/remind は Vercel Cron から呼ばれる想定で、共有シークレット(CRON_SECRET)必須(T10#4)。
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
  // 前回の同日テスト実行の cron_runs 行を消し、dedupガードの影響を受けないようにする
  await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/cron_runs?job=eq.osarai_remind`, {
    headers: { apikey: LOCAL_SERVICE_ROLE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_ROLE_KEY}` },
  });
}

test.describe('cron/remind: 前日の準備（明日会う人・明日までのTODO）', () => {
  test('CRON_SECRETが無い/違うと拒否される', async ({ request }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    const noAuth = await request.get('/api/cron/remind');
    expect(noAuth.status()).toBe(401);

    const wrongAuth = await request.get('/api/cron/remind', {
      headers: { authorization: 'Bearer wrong-secret' },
    });
    expect(wrongAuth.status()).toBe(401);
  });

  test('明日会う人（前回の話つき）と明日までのTODOがある人にだけ届き、ベルにも残る。同日2回目はスキップ', async ({
    request,
  }) => {
    test.skip(!CRON_SECRET, 'E2E_CRON_SECRET 未設定のためスキップ');
    await clearTodaysCronRun(request);

    const a = await newActiveUser(request, 'e2e-remind-a');
    const b = await newActiveUser(request, 'e2e-remind-b');

    // A: 明日 14:00(JST) に会う相手＋その人の議事録、明日が期限の TODO
    const cust = await restInsert(request, a.auth, 'customers', { org_id: a.orgId, owner_id: a.id, name: '通知テスト太郎', status: 'active' });
    await restInsert(request, a.auth, 'interactions', {
      org_id: a.orgId,
      customer_id: cust.id,
      author_id: a.id,
      source: 'zoom_rec',
      type: 'text',
      ai_summary: { points: [], needs: [], next_actions: [], minutes: '【相手の事業・プロフィール】\n- 都内でジムを2店舗運営' },
      met_at: new Date(Date.now() - 7 * 86400_000).toISOString(),
    });
    const jst = new Date(Date.now() + 9 * 3600_000);
    const tomorrow14 = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1, 5, 0));
    await restInsert(request, a.auth, 'schedules', {
      org_id: a.orgId,
      owner_id: a.id,
      customer_id: cust.id,
      title: '面談',
      start_at: tomorrow14.toISOString(),
      end_at: new Date(tomorrow14.getTime() + 3600_000).toISOString(),
    });
    await restInsert(request, a.auth, 'tasks', { org_id: a.orgId, owner_id: a.id, title: '資料を送る', due_at: tomorrow14.toISOString(), assignee: 'self' });

    const res = await request.get('/api/cron/remind', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { targeted: number; notified: number; configured: boolean };
    expect(body.targeted).toBeGreaterThanOrEqual(1);
    expect(body.configured).toBe(false); // ローカルE2EインスタンスにFCM_SERVICE_ACCOUNT未設定

    const notesA = await myNotifications(request, a.auth);
    expect(notesA.some((n) => n.title.includes('通知テスト太郎さんと会います') && (n.body ?? '').includes('前回の話: 都内でジムを2店舗運営'))).toBe(true);
    expect(notesA.some((n) => n.title === '明日までのTODOが1件あります' && n.link_path === '/tasks')).toBe(true);
    // 何も無い人には送らない（毎日の一律通知はやめた）
    expect(await myNotifications(request, b.auth)).toHaveLength(0);

    const res2 = await request.get('/api/cron/remind', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(((await res2.json()) as { skipped?: boolean }).skipped).toBe(true);
  });
});
