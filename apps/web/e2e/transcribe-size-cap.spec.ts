import { test, expect } from '@playwright/test';

// 要件定義書§6/§10「録音乱用に備え1録音あたりの上限のみ設定」の恒久回帰。
// /api/transcribe は大きすぎる録音を413で拒否する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

test('大きすぎる録音は413で拒否される', async ({ request }) => {
  test.setTimeout(60_000);

  // --- テストユーザー(Standardプラン=recordingImport可)+顧客を用意 ---
  const email = `e2e-rec-cap-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };

  const subRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: {
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${access_token}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    data: { user_id: user.id, plan: 'standard', status: 'active' },
  });
  expect(subRes.ok()).toBeTruthy();

  const profileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=org_id`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  const [profile] = (await profileRes.json()) as { org_id: string }[];
  const orgId = profile!.org_id;

  const customerRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: {
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${access_token}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    data: { org_id: orgId, owner_id: user.id, name: 'E2Eテスト顧客' },
  });
  expect(customerRes.ok()).toBeTruthy();
  const [customer] = (await customerRes.json()) as { id: string }[];
  if (!customer) throw new Error('customer creation returned no rows');

  // --- 26MB相当のダミー音声base64を送る(上限25MBを超える) ---
  const oversized = Buffer.alloc(26 * 1024 * 1024, 1).toString('base64');
  const res = await request.post('/api/transcribe', {
    headers: { Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    data: JSON.stringify({
      customerId: customer.id,
      audioBase64: oversized,
      mimeType: 'audio/webm',
      source: 'in_person_rec',
    }),
  });
  expect(res.status()).toBe(413);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('recording_too_large');
});
