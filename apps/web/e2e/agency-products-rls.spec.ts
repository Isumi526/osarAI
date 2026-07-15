import { test, expect } from '@playwright/test';

// 代理店が商品リストを作成し紹介ユーザーがアプリでインポートできるようにするチケットの回帰。
// agency_products テーブルのRLS(0020_agency_products.sql)を検証する:
// - leader は作成できる
// - 同組織の member は閲覧できるが作成はできない(RLSで拒否)
// - 別組織のユーザーからは見えない(テナント分離)

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

test('agency_products: leaderは作成可・memberは閲覧のみ可・別組織からは見えない', async ({ request }) => {
  const ts = Date.now();
  const leader = await signup(request, `e2e-agency-leader-${ts}@example.com`);
  const member = await signup(request, `e2e-agency-member-${ts}@example.com`);
  const outsider = await signup(request, `e2e-agency-outsider-${ts}@example.com`);

  // leaderへ昇格(通常はhandle_new_userトリガーでmember固定・手動付与を模倣)
  const promote = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${leader.userId}`, {
    headers: svc,
    data: { role: 'leader' },
  });
  expect(promote.ok()).toBeTruthy();

  // outsiderを別組織へ切り出す(テナント分離検証用。通常のsignupは全員LL組織固定のため
  // サービスロールで新規org作成+所属変更を行う)
  const otherOrgRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/organizations`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { name: `E2E他組織-${ts}` },
  });
  expect(otherOrgRes.ok()).toBeTruthy();
  const [otherOrg] = (await otherOrgRes.json()) as { id: string }[];
  const moveOutsider = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${outsider.userId}`, {
    headers: svc,
    data: { org_id: otherOrg!.id },
  });
  expect(moveOutsider.ok()).toBeTruthy();

  // 1. leaderが商品を作成できる
  const leaderProfileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${leader.userId}&select=org_id`, { headers: leader.authHeaders });
  const [leaderProfile] = (await leaderProfileRes.json()) as { org_id: string }[];
  const createRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products`, {
    headers: { ...leader.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: leader.userId, name: 'E2Eテスト商品', price: '月々1,000円' },
  });
  expect(createRes.ok()).toBeTruthy();
  const [product] = (await createRes.json()) as { id: string }[];

  // 2. 同組織のmemberは閲覧できる
  const memberReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}&select=id,name`, { headers: member.authHeaders });
  const memberRead = (await memberReadRes.json()) as { id: string }[];
  expect(memberRead.length).toBe(1);

  // 3. memberは作成できない(RLSで拒否・0件挿入 or エラー)
  const memberCreateRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products`, {
    headers: { ...member.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: member.userId, name: 'memberが勝手に作成' },
  });
  // RLS with checkに引っかかり、201でも空配列(=実質拒否)か、エラーステータスのいずれか。
  if (memberCreateRes.ok()) {
    const body = (await memberCreateRes.json()) as unknown[];
    expect(body.length).toBe(0);
  } else {
    expect(memberCreateRes.status()).toBeGreaterThanOrEqual(400);
  }

  // 4. 別組織のoutsiderからは見えない(テナント分離)
  const outsiderReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}&select=id`, { headers: outsider.authHeaders });
  const outsiderRead = (await outsiderReadRes.json()) as unknown[];
  expect(outsiderRead.length).toBe(0);

  // cleanup
  await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}`, { headers: svc });
});
