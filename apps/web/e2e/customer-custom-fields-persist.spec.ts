import { test, expect } from '@playwright/test';

// 顧客情報に商品/年齢/性別等の項目を追加しチャットからの登録に対応する（要件定義済みチケット）の回帰。
// おさらい対話のAI抽出は customers.custom_fields(既存jsonb) に products/age/gender を保存する想定
// （0007_profile_user_context.sql のuserProfile.products/age/genderと同じパターン）。
// 実際にAI抽出結果として書き込まれる形（apps/web/app/api/osarai/turn/route.ts が行うのと同じ
// custom_fields全体上書きPATCH）で保存→読み戻しが正しく永続することを確認する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('顧客のcustom_fields(products/age/gender)がPATCH保存→読み戻しで永続する', async ({ request }) => {
  const email = `e2e-customer-fields-${Date.now()}@example.com`;
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

  const customerRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: { ...authHeaders, Prefer: 'return=representation' },
    data: { org_id: profile!.org_id, owner_id: user.id, name: 'AI対話で商品/年齢/性別が判明した相手' },
  });
  expect(customerRes.ok()).toBeTruthy();
  const [customer] = (await customerRes.json()) as { id: string }[];

  // AI抽出結果として想定される custom_fields(products/age/gender + 他の特記事項)
  const customFields = { products: ['学資保険', '医療保険'], age: '30代', gender: '女性', memo: '紹介経由' };
  const patch = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${customer!.id}`, {
    headers: authHeaders,
    data: { custom_fields: customFields },
  });
  expect(patch.ok()).toBeTruthy();

  const read = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${customer!.id}&select=custom_fields`,
    { headers: authHeaders },
  );
  const [row] = (await read.json()) as { custom_fields: typeof customFields }[];
  expect(row!.custom_fields).toEqual(customFields);
});
