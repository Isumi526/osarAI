import { test, expect } from '@playwright/test';

// 「自分をおさらいする」対話で job/products を答えても user_profile.job/.products に
// 反映されず、次回以降も未登録扱いのまま同じ質問を聞き直してしまうバグの回帰。
// merge_user_profile_fields RPC(migration 0013)が、notesの追記と構造化フィールド
// (job/products等)のマージを、互いを上書きせずアトミックに行えることを直接確認する
// (Geminiの抽出精度はこのテストの対象外。RPCの永続化ロジックのみを検証)。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('merge_user_profile_fieldsはnotesの追記とjob/products等の構造化フィールドを両方永続する', async ({ request }) => {
  const email = `e2e-self-osarai-merge-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };
  const authHeaders = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };

  // 1ターン目: 仕事の内容を回答 → fields.jobが抽出された想定
  const turn1 = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/rpc/merge_user_profile_fields`, {
    headers: authHeaders,
    data: { new_notes: ['保険営業をしている'], new_fields: { job: '保険営業' } },
  });
  expect(turn1.ok()).toBeTruthy();

  // 2ターン目(別セッション想定): 扱っている商品を回答 → job は既存値のまま、productsが追加される
  // (Settings手動編集等の他フィールドと同様、jobを上書き・消失させないことを確認)
  const turn2 = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/rpc/merge_user_profile_fields`, {
    headers: authHeaders,
    data: { new_notes: ['医療保険の商品を扱っている'], new_fields: { products: '医療保険' } },
  });
  expect(turn2.ok()).toBeTruthy();

  const readRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=user_profile`, {
    headers: authHeaders,
  });
  const [row] = (await readRes.json()) as { user_profile: { job?: string; products?: string; notes?: string[] } }[];

  // job/productsが両方とも保存されている(=次回起動時にdecideOpening()が再度聞き直さない状態)
  expect(row!.user_profile.job).toBe('保険営業');
  expect(row!.user_profile.products).toBe('医療保険');
  // notesは上書きではなく追記されている
  expect(row!.user_profile.notes).toEqual(['保険営業をしている', '医療保険の商品を扱っている']);
});
