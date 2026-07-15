import { test, expect } from '@playwright/test';

// 代理店が紹介コードを管理できる画面を追加するチケットの回帰。
// referral_codes テーブルのRLS(0021_referral_codes.sql)を検証する:
// - leader は作成できる（org内でコードが重複していれば失敗する = unique制約）
// - member は閲覧できるが作成はできない
// - 別組織のユーザーからは見えない

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };

async function signup(request: import('@playwright/test').APIRequestContext, email: string) {
  const res = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(res.ok()).toBeTruthy();
  const { user, access_token } = (await res.json()) as { user: { id: string }; access_token: string };
  return { userId: user.id, authHeaders: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' } };
}

test('referral_codes: leaderは作成可・memberは閲覧のみ可・別組織からは見えない・org内で一意', async ({ request }) => {
  const ts = Date.now();
  const code = `E2ECODE${ts}`;
  const leader = await signup(request, `e2e-referral-leader-${ts}@example.com`);
  const member = await signup(request, `e2e-referral-member-${ts}@example.com`);
  const outsider = await signup(request, `e2e-referral-outsider-${ts}@example.com`);

  await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${leader.userId}`, { headers: svc, data: { role: 'leader' } });

  const otherOrgRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/organizations`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { name: `E2E他組織-referral-${ts}` },
  });
  const [otherOrg] = (await otherOrgRes.json()) as { id: string }[];
  await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${outsider.userId}`, { headers: svc, data: { org_id: otherOrg!.id } });

  const leaderProfileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${leader.userId}&select=org_id`, { headers: leader.authHeaders });
  const [leaderProfile] = (await leaderProfileRes.json()) as { org_id: string }[];

  // 1. leaderが記録できる
  const createRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes`, {
    headers: { ...leader.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: leader.userId, code, label: 'E2Eテスト' },
  });
  expect(createRes.ok()).toBeTruthy();
  const [rc] = (await createRes.json()) as { id: string }[];

  // 2. 同組織のmemberは閲覧できる
  const memberReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes?id=eq.${rc!.id}&select=id,code`, { headers: member.authHeaders });
  expect(((await memberReadRes.json()) as unknown[]).length).toBe(1);

  // 3. memberは作成できない
  const memberCreateRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes`, {
    headers: { ...member.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: member.userId, code: `${code}-member` },
  });
  if (memberCreateRes.ok()) {
    expect(((await memberCreateRes.json()) as unknown[]).length).toBe(0);
  } else {
    expect(memberCreateRes.status()).toBeGreaterThanOrEqual(400);
  }

  // 4. 別組織からは見えない
  const outsiderReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes?id=eq.${rc!.id}&select=id`, { headers: outsider.authHeaders });
  expect(((await outsiderReadRes.json()) as unknown[]).length).toBe(0);

  // 5. 同組織内での同一コード重複は unique(org_id, code) 制約で拒否される
  const dupRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes`, {
    headers: { ...leader.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: leader.userId, code },
  });
  expect(dupRes.status()).toBeGreaterThanOrEqual(400);

  await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/referral_codes?id=eq.${rc!.id}`, { headers: svc });
});
