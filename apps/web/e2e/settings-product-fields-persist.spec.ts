import { test, expect } from '@playwright/test';

// 商品情報の項目を見直す(購入条件を削除し魅力・概要/ターゲット・届けたい相手を追加する)チケットの回帰。
// apps/mobile/src/screens/Settings.tsx の updateMyUserProfile() が行うのと同じ
// profiles.user_profile への直接PATCHで、新しいproducts配列の形(name/price/appeal/target)が
// 保存→読み戻しで正しく永続することを確認する。
// （ターゲット/届けたい相手は当初別項目だったが、/review指摘でtarget1項目に統合した）

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('profiles.user_profile.productsが新フィールド構成(appeal/target)でPATCH保存→読み戻しで永続する', async ({ request }) => {
  const email = `e2e-product-fields-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };
  const authHeaders = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };

  const userProfile = {
    products: [
      {
        name: 'がん保険',
        price: '月々3,000円〜',
        appeal: '保険料そのままで入院給付が手厚い',
        target: '保障を見直したいと言っていた30〜40代の子育て世帯',
      },
    ],
  };
  const patch = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
    headers: authHeaders,
    data: { user_profile: userProfile },
  });
  expect(patch.ok()).toBeTruthy();

  const read = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=user_profile`, {
    headers: authHeaders,
  });
  const [row] = (await read.json()) as { user_profile: typeof userProfile }[];
  expect(row!.user_profile).toEqual(userProfile);
});
