import { test, expect } from '@playwright/test';

// ダッシュボード(Home画面)の個人集計(apps/mobile/src/lib/stats.ts getPersonalStats)が、
// 予定のカテゴリ(私用/会議/未設定)を正しく扱うかの回帰。
// - アポ系集計(monthAppointments/totalAppointments/upcomingSchedules)は私用を除外し、
//   カテゴリ未設定は除外しない(既定でアポ扱い)。
// - 会議系集計(monthMeetings/upcomingMeetings)はcategory=会議のみをカウントする。
// stats.tsはブラウザのsupabase-jsクライアントを直接叩くため、ここではPostgRESTへの
// REST呼び出しで同じフィルタ条件(or=(category.neq.私用,category.is.null) / category=eq.会議)
// を直接検証する(mobileにはE2Eハーネスが無いため、リスクがある集計クエリを直接確認)。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('予定集計は私用を除外しカテゴリ未設定は含み、会議はcategory=会議のみをカウントする', async ({ request }) => {
  const email = `e2e-stats-category-${Date.now()}@example.com`;
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

  const future = { start_at: '2027-01-01T10:00:00Z', end_at: '2027-01-01T11:00:00Z' };
  for (const category of ['私用', null, '会議']) {
    const res = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/schedules`, {
      headers: authHeaders,
      data: { org_id: profile!.org_id, owner_id: user.id, title: `カテゴリ:${category}`, category, ...future },
    });
    expect(res.ok()).toBeTruthy();
  }

  const countHeaders = { ...authHeaders, Prefer: 'count=exact' };

  const totalRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/schedules?select=id&start_at=gte.2020-01-01T00:00:00Z`, {
    headers: countHeaders,
  });
  expect(totalRes.headers()['content-range']).toBe('0-2/3');

  const appointmentsRes = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/schedules?select=id&start_at=gte.2020-01-01T00:00:00Z&or=(category.neq.私用,category.is.null)`,
    { headers: countHeaders },
  );
  // 私用1件が除外され、未設定+会議の2件が残る(アポ集計相当)
  expect(appointmentsRes.headers()['content-range']).toBe('0-1/2');

  const meetingsRes = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/schedules?select=id&start_at=gte.2020-01-01T00:00:00Z&category=eq.会議`,
    { headers: countHeaders },
  );
  expect(meetingsRes.headers()['content-range']).toBe('0-0/1');
});
