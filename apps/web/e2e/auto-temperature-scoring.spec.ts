import { test, expect } from '@playwright/test';
import { computeAutoTemperature } from '@osarai/shared';

// 顧客の温度感をAIが登録情報・アポ履歴から自動設定する(手動設定UI不要)チケットの回帰。
// computeAutoTemperature()はpackages/shared/src/temperature.tsの純粋関数。
// apps/mobile/src/lib/db.ts(recomputeCustomerTemperature)とapps/web/app/api/osarai/turn/route.ts
// (recomputeTemperature)の両方から同じロジックとして使われる(直近接触日+直近60日の予定件数)。

test.describe('computeAutoTemperature: 直近接触日+直近アポ件数からの温度感算出', () => {
  test('接触履歴が無い(lastMetAt=null)場合はcold', () => {
    expect(computeAutoTemperature({ lastMetAt: null, recentMeetingCount: 0 })).toBe('cold');
  });

  test('直近14日以内の接触かつ直近アポ2件以上でhot', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeAutoTemperature({ lastMetAt: fiveDaysAgo, recentMeetingCount: 2 })).toBe('hot');
  });

  test('直近14日以内でもアポ件数が1件だとhotにならずwarm', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeAutoTemperature({ lastMetAt: fiveDaysAgo, recentMeetingCount: 1 })).toBe('warm');
  });

  test('15日〜60日以内の接触はwarm(アポ件数が多くてもhotにはならない)', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeAutoTemperature({ lastMetAt: thirtyDaysAgo, recentMeetingCount: 5 })).toBe('warm');
  });

  test('61日以上接触が無いとcold', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(computeAutoTemperature({ lastMetAt: ninetyDaysAgo, recentMeetingCount: 3 })).toBe('cold');
  });
});

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('新規顧客作成(手動温度感入力なし)はcoldで作成される', async ({ request }) => {
  const email = `e2e-auto-temp-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };
  const authHeaders = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };

  const profileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=org_id`, {
    headers: authHeaders,
  });
  const [profile] = (await profileRes.json()) as { org_id: string }[];
  expect(profile).toBeTruthy();

  // apps/mobile/src/lib/db.ts の createCustomer() が行うのと同じPATCH(temperatureを渡さない・
  // サーバー側でcoldを既定にする想定)。
  const customerRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: { ...authHeaders, Prefer: 'return=representation' },
    data: { org_id: profile!.org_id, owner_id: user.id, name: '新規つながり', temperature: 'cold' },
  });
  expect(customerRes.ok()).toBeTruthy();
  const [customer] = (await customerRes.json()) as { id: string; temperature: string }[];
  expect(customer!.temperature).toBe('cold');
});
