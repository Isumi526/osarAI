import { test, expect } from '@playwright/test';

// 顧客情報に商品/年齢/性別等の項目を追加しチャットからの登録に対応するチケットの回帰
// （2026-07-16レビューで再発見されたバグ）。おさらい対話が複数ターンにまたがり、既存顧客
// （2ターン目以降）にcustom_fieldsを反映する際、apps/web/app/api/osarai/turn/route.ts の
// persistOnDone は当初 insert(新規顧客)分岐でしかcustom_fieldsを保存しておらず、
// update(既存顧客)分岐では一切保存されなかった（前ターンの情報が保存されないまま消える）。
// 0023のmerge_customer_custom_fields RPC（0013のmerge_user_profile_fieldsと同じ
// アトミックなjsonbマージパターン）で修正。route.tsが実際に呼ぶのと同じRPC呼び出し形で、
// 複数ターンにまたがっても前ターンの情報を保ちつつ新規分がマージされることを確認する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('既存顧客へのcustom_fields反映が複数ターンにまたがっても前ターンの情報を保ちつつマージされる', async ({ request }) => {
  const email = `e2e-customer-fields-merge-${Date.now()}@example.com`;
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

  // 1ターン目相当: 新規顧客作成時にproductsのみ判明（insert分岐・既存動作のまま）
  const customerRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: { ...authHeaders, Prefer: 'return=representation' },
    data: {
      org_id: profile!.org_id,
      owner_id: user.id,
      name: '複数ターンでcustom_fieldsが判明する相手',
      custom_fields: { products: ['学資保険'] },
    },
  });
  expect(customerRes.ok()).toBeTruthy();
  const [customer] = (await customerRes.json()) as { id: string }[];

  // 2ターン目相当: 既存顧客への追記（route.tsのpersistOnDone update分岐が呼ぶのと同じRPC）
  const rpcRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/rpc/merge_customer_custom_fields`, {
    headers: authHeaders,
    data: { target_customer_id: customer!.id, new_fields: { age: '30代', gender: '女性' } },
  });
  expect(rpcRes.ok()).toBeTruthy();

  const read = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${customer!.id}&select=custom_fields`,
    { headers: authHeaders },
  );
  const [row] = (await read.json()) as { custom_fields: { products?: string[]; age?: string; gender?: string } }[];
  // 1ターン目のproductsが消えず、2ターン目のage/genderが追加される
  expect(row!.custom_fields.products).toEqual(['学資保険']);
  expect(row!.custom_fields.age).toBe('30代');
  expect(row!.custom_fields.gender).toBe('女性');
});
