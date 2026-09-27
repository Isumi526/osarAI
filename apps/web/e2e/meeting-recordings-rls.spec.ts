import { test, expect } from '@playwright/test';

// 会議録音（migration 0028 meeting_recordings）の RLS 回帰（T0 の headless 検証をリポジトリに残す・T7）。
// 録音の生ログは個人の AI ログ扱い：本人のみ・org_id 照合。leader も他人の録音は見ない。
// 固定ローカルキーについては notifications-rls.spec.ts の注記を参照（本番の秘密ではない）。
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
  return {
    userId: user.id,
    authHeaders: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
  };
}

async function orgOf(request: import('@playwright/test').APIRequestContext, userId: string) {
  const res = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=org_id`, { headers: svc });
  expect(res.ok()).toBeTruthy();
  const [row] = (await res.json()) as { org_id: string }[];
  return row!.org_id;
}

test('meeting_recordings: 本人のみ読み書き可・他人はID直打ちでも参照/改ざん不可・他org/他人名義で作れない', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-meeting-me-${ts}@example.com`);
  const other = await signup(request, `e2e-meeting-other-${ts}@example.com`);
  const myOrg = await orgOf(request, me.userId);
  const otherOrg = await orgOf(request, other.userId);

  // 本人はユーザーJWTで自分の録音行を作れる（ingest はユーザースコープの anon クライアントで insert する）
  const mineRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { org_id: myOrg, user_id: me.userId, capture: 'pc_local', audio_url: `${me.userId}/meetings/a.webm`, status: 'reviewing', transcript: '自分: テスト' },
  });
  expect(mineRes.ok()).toBeTruthy();
  const [mine] = (await mineRes.json()) as { id: string }[];

  // 他人は一覧にも ID 直打ちにも出ない
  const list = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings?select=id`, { headers: other.authHeaders });
  expect(list.ok()).toBeTruthy();
  expect((await list.json()) as unknown[]).toHaveLength(0);
  const direct = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings?id=eq.${mine!.id}&select=id,transcript`, {
    headers: other.authHeaders,
  });
  expect(direct.ok()).toBeTruthy();
  expect((await direct.json()) as unknown[]).toHaveLength(0);

  // 他人は改ざんもできない（RLS で 0 行更新）
  const tamper = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings?id=eq.${mine!.id}`, {
    headers: { ...other.authHeaders, Prefer: 'return=representation' },
    data: { transcript: '改ざん' },
  });
  expect((await tamper.json()) as unknown[]).toHaveLength(0);
  const after = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings?id=eq.${mine!.id}&select=transcript`, { headers: svc });
  expect(((await after.json()) as { transcript: string }[])[0]!.transcript).toBe('自分: テスト');

  // 他人名義・他org での作成は拒否
  const forgeUser = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings`, {
    headers: { ...other.authHeaders, Prefer: 'return=representation' },
    data: { org_id: myOrg, user_id: me.userId, capture: 'pc_local', audio_url: `${me.userId}/meetings/b.webm` },
  });
  expect(forgeUser.ok()).toBeFalsy();
  // 自分名義でも「所属していない org」では作れない（org_id = current_org_id() の二重防御）。
  // signup 直後は全員が同じ初期組織に入るため、別組織を service_role で用意して越境を試す。
  const orgRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/organizations`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { name: `e2e-foreign-org-${ts}` },
  });
  expect(orgRes.ok()).toBeTruthy();
  const [foreignOrg] = (await orgRes.json()) as { id: string }[];
  expect(foreignOrg!.id).not.toBe(otherOrg);
  const forgeOrg = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings`, {
    headers: { ...other.authHeaders, Prefer: 'return=representation' },
    data: { org_id: foreignOrg!.id, user_id: other.userId, capture: 'pc_local', audio_url: `${other.userId}/meetings/c.webm` },
  });
  expect(forgeOrg.ok()).toBeFalsy();
});

test('merge_customers: 統合で meeting_recordings.customer_id が統合先に付け替わる（migration 0030）', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-meeting-merge-${ts}@example.com`);
  const myOrg = await orgOf(request, me.userId);

  const custRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/customers`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: [
      { org_id: myOrg, owner_id: me.userId, name: '統合元' },
      { org_id: myOrg, owner_id: me.userId, name: '統合先' },
    ],
  });
  expect(custRes.ok()).toBeTruthy();
  const [src, tgt] = (await custRes.json()) as { id: string; name: string }[];

  const recRes = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { org_id: myOrg, user_id: me.userId, customer_id: src!.id, capture: 'pc_local', audio_url: `${me.userId}/meetings/m.webm`, status: 'done' },
  });
  expect(recRes.ok()).toBeTruthy();
  const [rec] = (await recRes.json()) as { id: string }[];

  const merge = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/rpc/merge_customers`, {
    headers: me.authHeaders,
    data: { source_id: src!.id, target_id: tgt!.id },
  });
  expect(merge.ok()).toBeTruthy();

  const after = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings?id=eq.${rec!.id}&select=customer_id`, {
    headers: me.authHeaders,
  });
  expect(((await after.json()) as { customer_id: string | null }[])[0]!.customer_id).toBe(tgt!.id);
});
