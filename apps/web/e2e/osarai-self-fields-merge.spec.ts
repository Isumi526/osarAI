import { test, expect } from '@playwright/test';

// おさらい対話で出た自分自身の重要な情報もプロフィールに反映できるようにするチケットの回帰。
// apps/web/app/api/osarai/turn/route.ts の persistOnDone が、顧客向けおさらい対話中に
// 判明した自分自身の情報(self_fields)を merge_user_profile_fields RPC で
// (new_notes=[]・new_fields=self_fields の形で)反映する。RPC自体の永続化ロジックは
// self-osarai-profile-merge.spec.ts で検証済みのため、ここでは「おさらい対話由来の
// 呼び出しパターン(notesが空配列)」でも既存のuser_profileを壊さず反映されることを確認する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('おさらい対話由来のnew_notes=[]呼び出しでも既存user_profileを保ちつつself_fieldsが反映される', async ({ request }) => {
  const email = `e2e-osarai-self-fields-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };
  const authHeaders = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };

  // 事前に既存の自由記述フィールドがある状態(Settingsで手動編集済み等)を再現
  await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
    headers: authHeaders,
    data: { user_profile: { age: '30代' } },
  });

  // おさらい対話完了時のpersistOnDoneと同じ呼び出し形(new_notes=[]・new_fields=self_fields抽出結果)
  const res = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/rpc/merge_user_profile_fields`, {
    headers: authHeaders,
    data: { new_notes: [], new_fields: { job: '保険業界' } },
  });
  expect(res.ok()).toBeTruthy();

  const readRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=user_profile`, { headers: authHeaders });
  const [row] = (await readRes.json()) as { user_profile: { age?: string; job?: string; notes?: string[] } }[];
  // 既存のage(手動編集済み)を消さず、新たにjobが追加される
  expect(row!.user_profile.age).toBe('30代');
  expect(row!.user_profile.job).toBe('保険業界');
  // notesが空配列でも壊れず(undefinedやエラーにならず)、追記も発生しない
  expect(row!.user_profile.notes ?? []).toEqual([]);
});
