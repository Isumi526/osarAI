import { test, expect } from '@playwright/test';

// 退会（2026-09-28）: アプリ内から退会すると、本人のデータ・録音音声・ログイン情報がすべて消え、
// 他人のデータには触れない。誤操作防止の確認と、管理者アカウントの保護も確かめる。
const SUPA = 'http://127.0.0.1:54321';
const ANON = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };
type Req = import('@playwright/test').APIRequestContext;

async function newUser(request: Req, prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request.post(`${SUPA}/auth/v1/signup`, {
    headers: { apikey: ANON, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(r.ok()).toBeTruthy();
  const { user, access_token } = (await r.json()) as { user: { id: string }; access_token: string };
  const auth = { apikey: ANON, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  await request.post(`${SUPA}/rest/v1/subscriptions`, {
    headers: { ...svc, Prefer: 'resolution=merge-duplicates' },
    data: { user_id: user.id, plan: 'light', status: 'trialing' },
  });
  const [p] = (await (await request.get(`${SUPA}/rest/v1/profiles?id=eq.${user.id}&select=org_id`, { headers: svc })).json()) as { org_id: string }[];
  return { id: user.id, email, orgId: p!.org_id, auth, token: access_token };
}
async function insert(request: Req, table: string, data: Record<string, unknown>) {
  const r = await request.post(`${SUPA}/rest/v1/${table}`, { headers: { ...svc, Prefer: 'return=representation' }, data });
  expect(r.ok(), `${table}: ${await r.text()}`).toBeTruthy();
  return ((await r.json()) as { id: string }[])[0]!;
}
async function count(request: Req, table: string, filter: string) {
  const r = await request.get(`${SUPA}/rest/v1/${table}?${filter}&select=*`, { headers: { ...svc, Prefer: 'count=exact' } });
  return Number((r.headers()['content-range'] ?? '0/0').split('/')[1]);
}

test('退会: 本人のデータ・録音音声・ログイン情報が消え、他人のデータは残る', async ({ request }) => {
  const me = await newUser(request, 'e2e-delete-me');
  const other = await newUser(request, 'e2e-delete-other');
  // 自分が紹介した人（紹介元だけ外れて、相手のアカウントは残る）
  await request.patch(`${SUPA}/rest/v1/profiles?id=eq.${other.id}`, { headers: svc, data: { referred_by: me.id } });

  const cust = await insert(request, 'customers', { org_id: me.orgId, owner_id: me.id, name: '退会テスト相手', status: 'active' });
  await insert(request, 'interactions', { org_id: me.orgId, customer_id: cust.id, author_id: me.id, source: 'manual', type: 'text', raw_text: 'x' });
  await insert(request, 'tasks', { org_id: me.orgId, owner_id: me.id, title: 't', assignee: 'other' });
  await insert(request, 'schedules', {
    org_id: me.orgId, owner_id: me.id, title: 's', start_at: new Date().toISOString(), end_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  await insert(request, 'meeting_recordings', { org_id: me.orgId, user_id: me.id, capture: 'pc_local', status: 'done' });
  await insert(request, 'notifications', { org_id: me.orgId, user_id: me.id, category: 'reminder', title: 'n' });
  // 録音音声（Storage）
  const up = await request.post(`${SUPA}/storage/v1/object/recordings/${me.id}/meetings/e2e.webm`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'audio/webm' },
    data: Buffer.from('audio'),
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const otherCust = await insert(request, 'customers', { org_id: other.orgId, owner_id: other.id, name: '他人の相手', status: 'active' });

  // 確認の合言葉が無いと消さない（誤操作防止）
  const noConfirm = await request.post('/api/account/delete', { headers: { Authorization: `Bearer ${me.token}`, 'content-type': 'application/json' }, data: {} });
  expect(noConfirm.status()).toBe(400);
  expect(await count(request, 'customers', `owner_id=eq.${me.id}`)).toBe(1);

  const res = await request.post('/api/account/delete', {
    headers: { Authorization: `Bearer ${me.token}`, 'content-type': 'application/json' },
    data: { confirm: 'DELETE_MY_ACCOUNT' },
  });
  expect(res.status(), await res.text()).toBe(200);

  for (const [t, f] of [
    ['customers', `owner_id=eq.${me.id}`],
    ['interactions', `author_id=eq.${me.id}`],
    ['tasks', `owner_id=eq.${me.id}`],
    ['schedules', `owner_id=eq.${me.id}`],
    ['meeting_recordings', `user_id=eq.${me.id}`],
    ['notifications', `user_id=eq.${me.id}`],
    ['subscriptions', `user_id=eq.${me.id}`],
    ['profiles', `id=eq.${me.id}`],
  ] as const) {
    expect(await count(request, t, f), t).toBe(0);
  }
  const file = await request.get(`${SUPA}/storage/v1/object/recordings/${me.id}/meetings/e2e.webm`, { headers: svc });
  expect(file.status()).not.toBe(200);
  // ログインできない
  const login = await request.post(`${SUPA}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON, 'content-type': 'application/json' },
    data: { email: me.email, password: 'testpassword123' },
  });
  expect(login.ok()).toBe(false);
  // 他人のデータは残り、紹介元だけ外れる
  expect(await count(request, 'customers', `id=eq.${otherCust.id}`)).toBe(1);
  const [op] = (await (await request.get(`${SUPA}/rest/v1/profiles?id=eq.${other.id}&select=referred_by`, { headers: svc })).json()) as { referred_by: string | null }[];
  expect(op!.referred_by).toBeNull();
});

test('退会: 未ログインは 401・管理者アカウントは自分では消せない・本人の JWT から削除関数は呼べない', async ({ request }) => {
  const unauth = await request.post('/api/account/delete', { data: { confirm: 'DELETE_MY_ACCOUNT' } });
  expect(unauth.status()).toBe(401);

  const leader = await newUser(request, 'e2e-delete-leader');
  await request.patch(`${SUPA}/rest/v1/profiles?id=eq.${leader.id}`, { headers: svc, data: { role: 'leader' } });
  const res = await request.post('/api/account/delete', {
    headers: { Authorization: `Bearer ${leader.token}`, 'content-type': 'application/json' },
    data: { confirm: 'DELETE_MY_ACCOUNT' },
  });
  expect(res.status()).toBe(409);
  expect(await count(request, 'profiles', `id=eq.${leader.id}`)).toBe(1);

  // 削除関数は service_role 専用（本人の JWT で他人を消せないこと）
  const victim = await newUser(request, 'e2e-delete-victim');
  const rpc = await request.post(`${SUPA}/rest/v1/rpc/delete_account_data`, { headers: leader.auth, data: { p_user: victim.id } });
  expect(rpc.ok()).toBe(false);
  expect(await count(request, 'profiles', `id=eq.${victim.id}`)).toBe(1);
});
