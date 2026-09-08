import { test, expect } from '@playwright/test';

// アプリ内通知（migration 0029）のRLS回帰。
// 通知は「個人宛の連絡」なので、顧客データと違い leader も他人の分は見られない。
// 特に大事なのは【クライアントから作れないこと】＝作れると運営者を装った
// 「お知らせ」を自分や他人に差し込めてしまう。作成は service_role だけに許す。
// このキーは `supabase start` がローカル開発用に誰の環境でも同じ値で配る固定キーで、
// 本番の秘密ではない（本番キーは .env にあり、ここには持ち込まない）。既存のRLS系specも
// 同じ値を同じ形で持っているため揃えている。env化するなら全spec一括で行うこと。
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

test('notifications: 本人のみ閲覧可・他人の通知は見えない・クライアントからは作成できない', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-notif-me-${ts}@example.com`);
  const other = await signup(request, `e2e-notif-other-${ts}@example.com`);
  const myOrg = await orgOf(request, me.userId);
  const otherOrg = await orgOf(request, other.userId);

  // 運営(service_role)が2人分の通知を作る＝本来の作成経路
  const seed = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/notifications`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: [
      { org_id: myOrg, user_id: me.userId, category: 'announce', title: '自分あてのお知らせ' },
      { org_id: myOrg, user_id: me.userId, category: 'reminder', title: '自分あてのリマインド' },
      { org_id: otherOrg, user_id: other.userId, category: 'announce', title: '他人あてのお知らせ' },
    ],
  });
  expect(seed.ok()).toBeTruthy();
  const created = (await seed.json()) as { id: string; user_id: string }[];
  const mine = created.filter((r) => r.user_id === me.userId);
  const theirs = created.find((r) => r.user_id === other.userId)!;

  // 本人は自分の2件だけ見える
  const list = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?select=id,title`, { headers: me.authHeaders });
  expect(list.ok()).toBeTruthy();
  const visible = (await list.json()) as { id: string; title: string }[];
  expect(visible.map((r) => r.id).sort()).toEqual(mine.map((r) => r.id).sort());
  expect(visible.some((r) => r.title === '他人あてのお知らせ')).toBe(false);

  // 他人の通知はIDを知っていても取れない（ID直打ちでの越境）
  const direct = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?id=eq.${theirs.id}&select=id`, {
    headers: me.authHeaders,
  });
  expect(direct.ok()).toBeTruthy();
  expect((await direct.json()) as unknown[]).toHaveLength(0);

  // ★クライアントからは自分あてであっても作成できない（お知らせの偽装を防ぐ）
  const forge = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/notifications`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { org_id: myOrg, user_id: me.userId, category: 'announce', title: '運営を装ったお知らせ' },
  });
  expect(forge.ok()).toBeFalsy();

  // 他人あての通知を作ることもできない
  const forgeOther = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/notifications`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { org_id: otherOrg, user_id: other.userId, category: 'announce', title: '他人に差し込むお知らせ' },
  });
  expect(forgeOther.ok()).toBeFalsy();
});

test('notifications: 本人は既読にできるが、他人の通知は既読にできない', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-notif-read-me-${ts}@example.com`);
  const other = await signup(request, `e2e-notif-read-other-${ts}@example.com`);
  const myOrg = await orgOf(request, me.userId);
  const otherOrg = await orgOf(request, other.userId);

  const seed = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/notifications`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: [
      { org_id: myOrg, user_id: me.userId, category: 'reminder', title: '自分の未読' },
      { org_id: otherOrg, user_id: other.userId, category: 'reminder', title: '他人の未読' },
    ],
  });
  expect(seed.ok()).toBeTruthy();
  const rows = (await seed.json()) as { id: string; user_id: string }[];
  const mineId = rows.find((r) => r.user_id === me.userId)!.id;
  const theirsId = rows.find((r) => r.user_id === other.userId)!.id;

  // 自分の通知は既読にできる
  const readMine = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?id=eq.${mineId}`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { read_at: new Date().toISOString() },
  });
  expect(readMine.ok()).toBeTruthy();
  expect((await readMine.json()) as unknown[]).toHaveLength(1);

  // 他人の通知は既読にできない（RLSで対象0件になる＝黙って何も更新されない）
  const readTheirs = await request.patch(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?id=eq.${theirsId}`, {
    headers: { ...me.authHeaders, Prefer: 'return=representation' },
    data: { read_at: new Date().toISOString() },
  });
  expect(readTheirs.ok()).toBeTruthy();
  expect((await readTheirs.json()) as unknown[]).toHaveLength(0);

  // 実際に他人の通知が未読のままであることをservice_roleで確認する
  const check = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/notifications?id=eq.${theirsId}&select=read_at`, {
    headers: svc,
  });
  const [after] = (await check.json()) as { read_at: string | null }[];
  expect(after!.read_at).toBeNull();
});
