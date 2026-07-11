import { test, expect } from '@playwright/test';

// F-02 AC「生成されたサマリをユーザーが確認・修正できる」の回帰。
// apps/mobile/src/lib/db.ts の updateInteractionSummary() が行うのと同じ
// interactions/customers への直接PATCH(RLSスコープ済みクライアント経由)が、
// 本人の行に対して許可されることを確認する(mobileにはE2Eハーネスが無いため、
// 実際にリスクがある箇所=RLS権限を web側のPlaywrightから直接検証する)。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('本人のinteraction/customerはサマリ編集(PATCH)で上書きできる', async ({ request }) => {
  const email = `e2e-osarai-edit-${Date.now()}@example.com`;
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

  // AIが自動保存した想定の顧客+interaction(元のAI抽出値)を用意
  const customerRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: { ...authHeaders, Prefer: 'return=representation' },
    data: { org_id: profile!.org_id, owner_id: user.id, name: 'AI抽出の仮名', temperature: 'cold', needs: 'AIの誤抽出' },
  });
  expect(customerRes.ok()).toBeTruthy();
  const [customer] = (await customerRes.json()) as { id: string }[];

  const interactionRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/interactions`, {
    headers: { ...authHeaders, Prefer: 'return=representation' },
    data: {
      org_id: profile!.org_id,
      customer_id: customer!.id,
      author_id: user.id,
      source: 'ai_dialogue',
      type: 'text',
      ai_summary: { points: ['AIの初期抽出'], needs: [], next_actions: [] },
    },
  });
  expect(interactionRes.ok()).toBeTruthy();
  const [interaction] = (await interactionRes.json()) as { id: string }[];

  // ユーザーが確認画面で修正して保存(= updateInteractionSummary相当のPATCH)
  const editedSummary = { points: ['正しい要点'], needs: ['本当のニーズ'], next_actions: ['来週電話する'] };
  const ixPatch = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/interactions?id=eq.${interaction!.id}`, {
    headers: authHeaders,
    data: { ai_summary: editedSummary },
  });
  expect(ixPatch.ok()).toBeTruthy();

  const custPatch = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${customer!.id}`, {
    headers: authHeaders,
    data: { temperature: 'hot', needs: '本当のニーズ' },
  });
  expect(custPatch.ok()).toBeTruthy();

  // 読み戻して修正が反映されていることを確認
  const readIx = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/interactions?id=eq.${interaction!.id}&select=ai_summary`,
    { headers: authHeaders },
  );
  const [ixRow] = (await readIx.json()) as { ai_summary: typeof editedSummary }[];
  expect(ixRow!.ai_summary).toEqual(editedSummary);

  const readCust = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${customer!.id}&select=temperature,needs`,
    { headers: authHeaders },
  );
  const [custRow] = (await readCust.json()) as { temperature: string; needs: string }[];
  expect(custRow!.temperature).toBe('hot');
  expect(custRow!.needs).toBe('本当のニーズ');
});
