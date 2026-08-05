import { test, expect } from '@playwright/test';

// 代理店が商品リストを作成し紹介ユーザーがアプリでインポートできるようにするチケットの回帰。
// 【要設計判断】代理店/リーダー再設計(回答A・0024)後のagency_products RLSを検証する:
// - 有効なLeaderプラン契約者(subscriptions.plan='leader'・旧: profiles.role='leader')は作成できる
// - 自分を招待した(referred_by)リーダーの商品は閲覧できるが、無関係の別リーダーの商品は
//   見えない(旧: org全体スコープだったのが誤りだったため、招待元限定に修正)
// - Leaderプラン契約者以外は作成できない(RLSで拒否)
// - 別組織のユーザーからは見えない(テナント分離)
// - 別のLeaderプラン契約者は他者が作成した行を削除できない(0022由来の作成者限定の回帰)

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

test('agency_products: 有効なLeaderプラン契約者は作成可・招待メンバーは招待元の商品のみ閲覧可・別組織/無関係リーダーからは見えない', async ({ request }) => {
  const ts = Date.now();
  const leader = await signup(request, `e2e-agency-leader-${ts}@example.com`);
  const leader2 = await signup(request, `e2e-agency-leader2-${ts}@example.com`);
  const member = await signup(request, `e2e-agency-member-${ts}@example.com`);
  const unrelatedMember = await signup(request, `e2e-agency-unrelated-${ts}@example.com`);
  const outsider = await signup(request, `e2e-agency-outsider-${ts}@example.com`);

  // leader/leader2を「有効なLeaderプラン契約者」に昇格(通常は運営者がDBを手動更新する運用を模倣)
  for (const l of [leader, leader2]) {
    const promote = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
      headers: { ...svc, Prefer: 'return=representation' },
      data: { user_id: l.userId, plan: 'leader', status: 'active' },
    });
    expect(promote.ok()).toBeTruthy();
  }
  // memberはleaderに招待された体で referred_by を設定(通常は signup時の ?ref= 経由で自動設定される)
  const setReferrer = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${member.userId}`, {
    headers: svc,
    data: { referred_by: leader.userId },
  });
  expect(setReferrer.ok()).toBeTruthy();
  // unrelatedMemberはleader2に招待された体(=leaderの商品は見えないはず)
  const setReferrer2 = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${unrelatedMember.userId}`, {
    headers: svc,
    data: { referred_by: leader2.userId },
  });
  expect(setReferrer2.ok()).toBeTruthy();

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

  // 1. 有効なLeaderプラン契約者が商品を作成できる
  const leaderProfileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${leader.userId}&select=org_id`, { headers: leader.authHeaders });
  const [leaderProfile] = (await leaderProfileRes.json()) as { org_id: string }[];
  const createRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products`, {
    headers: { ...leader.authHeaders, Prefer: 'return=representation' },
    data: { org_id: leaderProfile!.org_id, created_by: leader.userId, name: 'E2Eテスト商品', price: '月々1,000円' },
  });
  expect(createRes.ok()).toBeTruthy();
  const [product] = (await createRes.json()) as { id: string }[];

  // 2. 招待元(referred_by=leader)のmemberは閲覧できる
  const memberReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}&select=id,name`, { headers: member.authHeaders });
  const memberRead = (await memberReadRes.json()) as { id: string }[];
  expect(memberRead.length).toBe(1);

  // 2'. 【スコープ修正の回帰確認】無関係のリーダー(leader2)に招待されたunrelatedMemberからは見えない
  //     (旧実装はorg全体スコープで見えてしまっていたのが誤りだった)
  const unrelatedReadRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}&select=id`, { headers: unrelatedMember.authHeaders });
  expect(((await unrelatedReadRes.json()) as unknown[]).length).toBe(0);

  // 3. Leaderプラン契約の無いmemberは作成できない(RLSで拒否・0件挿入 or エラー)
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

  // 5. 別のLeaderプラン契約者(leader2)は他者が作成した行を削除できない(0022由来の作成者限定の回帰確認)
  const leader2DeleteRes = await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}`, {
    headers: { ...leader2.authHeaders, Prefer: 'return=representation' },
  });
  const leader2DeleteBody = (await leader2DeleteRes.json().catch(() => [])) as unknown[];
  expect(leader2DeleteBody.length).toBe(0); // RLSにより実質ゼロ件更新(他者の行は対象外)
  const stillExistsRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}&select=id`, { headers: leader.authHeaders });
  expect(((await stillExistsRes.json()) as unknown[]).length).toBe(1);

  // cleanup（作成者本人=leaderなら削除できることも併せて確認）
  const ownDeleteRes = await request.delete(`${LOCAL_SUPABASE_URL}/rest/v1/agency_products?id=eq.${product!.id}`, {
    headers: { ...leader.authHeaders, Prefer: 'return=representation' },
  });
  expect(((await ownDeleteRes.json()) as unknown[]).length).toBe(1);
});
