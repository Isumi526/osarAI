import { test, expect } from '@playwright/test';

// 2026-08-05 の人力レビューで発見した不具合の回帰。
// おさらい対話で新規のつながりカードを作る場合、保存されるのは「最終ターンの抽出結果」だけ
// だったため、Geminiがそのターンで custom_fields の一部(age/gender等)を落とすと、
// 対話中に判明していた商品/年齢/性別が丸ごと失われていた（実際に custom_fields={} になった）。
// 既存顧客は merge_customer_custom_fields(0023) で守られていたが、新規顧客には効かない経路だった。
// 0025 で osarai_sessions.accumulated_fields にターンごとマージして保持するようにした。
//
// 注: このspecは実際のGemini APIを叩く（抽出そのものが検証対象のため）。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };

test('おさらいで新規作成したつながりに、複数ターンで判明した商品/年齢/性別がすべて保存される', async ({ request }) => {
  test.setTimeout(180_000); // 実Gemini呼び出しを複数ターン行うため

  const email = `e2e-osarai-accum-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };

  // 契約ゲート(§16)を満たすためのトライアル契約をシード
  await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { user_id: user.id, plan: 'standard', status: 'trialing' },
  });

  const authHeaders = { Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  const name = `テスト三郎${Date.now()}`;
  // 情報を意図的にターンごとに分けて話す（1ターンで全部言わない＝取りこぼしが起きる条件）
  const turns = [`${name}さんと会った`, '保険を扱っているらしい', '30代の男性だった'];

  let sessionId: string | undefined;
  for (const message of turns) {
    const res = await request.post('/api/osarai/turn', {
      headers: authHeaders,
      data: { message, sessionId, remainingSec: 240 },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { sessionId: string; done: boolean };
    sessionId = body.sessionId;
    if (body.done) break; // ユーザー発話が終了意図と解釈された場合は以降のターンを送らない
  }

  const endRes = await request.post('/api/osarai/turn', {
    headers: authHeaders,
    data: { message: '', sessionId, forceEnd: true },
  });
  // 既にdone済みなら409（その場合は上のループ内で保存済み）
  expect([200, 409]).toContain(endRes.status());

  const customersRes = await request.get(
    `${LOCAL_SUPABASE_URL}/rest/v1/customers?owner_id=eq.${user.id}&select=name,custom_fields`,
    { headers: { ...svc } },
  );
  const customers = (await customersRes.json()) as { name: string; custom_fields: Record<string, unknown> }[];
  expect(customers.length).toBeGreaterThan(0);
  const cf = customers[0]!.custom_fields ?? {};

  // 会話で明確に話した3項目がすべて残っていること（どれか1つでも欠けたら回帰）
  expect(Array.isArray(cf.products) ? (cf.products as string[]).join('') : '').toContain('保険');
  expect(String(cf.age ?? '')).toContain('30');
  expect(String(cf.gender ?? '')).toBeTruthy();
});
