import { test, expect } from '@playwright/test';

// 会議録音 API のガード回帰（T7）。Gemini に到達する前の入口で止まることを確認する
// （未認証 401 / 未契約 402 / 他人のパス 403 / reviewing 以外の commit 409）。
// 前提: local Supabase（54321）＋ E2E 用 dev server（baseURL・local Supabase 向け）。
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
  return { userId: user.id, token: access_token };
}

async function orgOf(request: import('@playwright/test').APIRequestContext, userId: string) {
  const res = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=org_id`, { headers: svc });
  const [row] = (await res.json()) as { org_id: string }[];
  return row!.org_id;
}

async function activate(request: import('@playwright/test').APIRequestContext, userId: string, plan: string) {
  const res = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: { ...svc, Prefer: 'resolution=merge-duplicates' },
    data: { user_id: userId, plan, status: 'trialing' },
  });
  expect(res.ok()).toBeTruthy();
}

test('meeting/upload-url・ingest: 未認証401 / 未契約402 / Light は録音可（D1） / 他人のパスは403', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-meeting-guard-${ts}@example.com`);
  const other = await signup(request, `e2e-meeting-guard-other-${ts}@example.com`);

  const noAuth = await request.post('/api/meeting/upload-url', { data: { mimeType: 'audio/webm' } });
  expect(noAuth.status()).toBe(401);

  const auth = { Authorization: `Bearer ${me.token}`, 'content-type': 'application/json' };
  const noSub = await request.post('/api/meeting/upload-url', { headers: auth, data: { mimeType: 'audio/webm' } });
  expect(noSub.status()).toBe(402);

  // Light（新規登録の既定プラン）でも会議録音は使える（D1・2026-09-13）
  await activate(request, me.userId, 'light');
  const light = await request.post('/api/meeting/upload-url', { headers: auth, data: { mimeType: 'audio/webm' } });
  expect(light.status()).toBe(200);
  const { path } = (await light.json()) as { path: string };
  expect(path.startsWith(`${me.userId}/`)).toBe(true);

  // 招待制の無料 member は不可（未知の plan は subscriptions.plan の CHECK 制約で DB に入らないため、
  // フェイルクローズ側の分岐はここでは member で代表させる）
  await activate(request, me.userId, 'member');
  expect((await request.post('/api/meeting/upload-url', { headers: auth, data: { mimeType: 'audio/webm' } })).status()).toBe(403);

  // 他人のパスを ingest に渡しても 403（所有者チェック・Gemini には到達しない）
  await activate(request, other.userId, 'light');
  const foreign = await request.post('/api/meeting/ingest', {
    headers: { Authorization: `Bearer ${other.token}`, 'content-type': 'application/json' },
    data: { recordingPath: path, mimeType: 'audio/webm', capture: 'pc_local' },
  });
  expect(foreign.status()).toBe(403);
});

test('meeting/commit: reviewing 以外の行は 409・done は already_committed・名前未入力は 400', async ({ request }) => {
  const ts = Date.now();
  const me = await signup(request, `e2e-meeting-commit-${ts}@example.com`);
  await activate(request, me.userId, 'light');
  const org = await orgOf(request, me.userId);
  const auth = { Authorization: `Bearer ${me.token}`, 'content-type': 'application/json' };

  const mk = async (status: string) => {
    const res = await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/meeting_recordings`, {
      headers: { ...svc, Prefer: 'return=representation' },
      data: { org_id: org, user_id: me.userId, capture: 'pc_local', audio_url: `${me.userId}/meetings/${status}-${ts}.webm`, status, transcript: '自分: a' },
    });
    expect(res.ok()).toBeTruthy();
    return ((await res.json()) as { id: string }[])[0]!.id;
  };
  const proposals = { people: [{ customer_id: null, name: '相手A', points: [], needs: [], next_actions: [] }], schedules: [], tasks: [], self_notes: [] };

  const processing = await request.post('/api/meeting/commit', { headers: auth, data: { meetingId: await mk('processing'), proposals } });
  expect(processing.status()).toBe(409);
  expect(((await processing.json()) as { error: string }).error).toBe('not_reviewable');

  const done = await request.post('/api/meeting/commit', { headers: auth, data: { meetingId: await mk('done'), proposals } });
  expect(done.status()).toBe(409);
  expect(((await done.json()) as { error: string }).error).toBe('already_committed');

  const unnamed = await request.post('/api/meeting/commit', {
    headers: auth,
    data: { meetingId: await mk('reviewing'), proposals: { ...proposals, people: [{ customer_id: null, name: '', points: [], needs: [], next_actions: [] }] } },
  });
  expect(unnamed.status()).toBe(400);
});
