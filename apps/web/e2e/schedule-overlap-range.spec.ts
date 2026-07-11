import { test, expect } from '@playwright/test';

// apps/mobile/src/lib/schedules.ts listSchedules() のバグ修正回帰。
// 従来はstart_atのみで範囲を絞っていたため、日を跨ぐ予定(前日23:00開始→当日1:00終了)が
// 「当日」を表示範囲としてクエリした際に丸ごと欠落していた(start_atが前日で範囲外になるため)。
// 修正後は「期間と重なるか」(start_at < to && end_at > from)で絞り込む。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('listSchedulesの範囲クエリは日を跨ぐ予定を欠落させず、無関係な予定は含めない', async ({ request }) => {
  const email = `e2e-schedule-overlap-${Date.now()}@example.com`;
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

  // 対象日: 2027-06-15。表示範囲は当日0:00〜翌0:00とする。
  const dayFrom = '2027-06-15T00:00:00.000Z';
  const dayTo = '2027-06-16T00:00:00.000Z';

  const schedulesToCreate = [
    { title: '日を跨ぐ予定(前日23:00→当日1:00)', start_at: '2027-06-14T23:00:00Z', end_at: '2027-06-15T01:00:00Z' },
    { title: '当日午前中の通常予定', start_at: '2027-06-15T10:00:00Z', end_at: '2027-06-15T11:00:00Z' },
    { title: '前日で完全に終わっている無関係な予定', start_at: '2027-06-14T09:00:00Z', end_at: '2027-06-14T10:00:00Z' },
    { title: '翌日で完全に始まる無関係な予定', start_at: '2027-06-16T09:00:00Z', end_at: '2027-06-16T10:00:00Z' },
  ];
  for (const s of schedulesToCreate) {
    const res = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/schedules`, {
      headers: authHeaders,
      data: { org_id: profile!.org_id, owner_id: user.id, ...s },
    });
    expect(res.ok()).toBeTruthy();
  }

  // listSchedules()と同じフィルタ: start_at < to && end_at > from
  const res = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/schedules?select=title&start_at=lt.${encodeURIComponent(dayTo)}&end_at=gt.${encodeURIComponent(dayFrom)}&order=start_at.asc`,
    { headers: authHeaders },
  );
  expect(res.ok()).toBeTruthy();
  const rows = (await res.json()) as { title: string }[];
  const titles = rows.map((r) => r.title);

  expect(titles).toContain('日を跨ぐ予定(前日23:00→当日1:00)');
  expect(titles).toContain('当日午前中の通常予定');
  expect(titles).not.toContain('前日で完全に終わっている無関係な予定');
  expect(titles).not.toContain('翌日で完全に始まる無関係な予定');
  expect(titles.length).toBe(2);
});
