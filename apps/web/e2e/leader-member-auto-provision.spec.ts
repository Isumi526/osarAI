import { test, expect } from '@playwright/test';

// 【要設計判断】代理店/リーダー再設計(回答A・0024)の回帰。
// 有効なLeaderプラン契約者(subscriptions.plan='leader'・active/trialing)の紹介コード(?ref=)
// 経由で新規signupすると、Stripeを一切経由せず無料の'member'プランが自動発行される
// (handle_new_user()トリガーの拡張)。招待元がLeaderプランでない/未契約の場合は
// 自動発行されない(通常どおり/subscribeへ誘導される=何もsubscriptionsが作られない)ことも確認する。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };

async function signup(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  data?: Record<string, string>,
) {
  const res = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123', data },
  });
  expect(res.ok()).toBeTruthy();
  const { user, access_token } = (await res.json()) as { user: { id: string }; access_token: string };
  return { userId: user.id, authHeaders: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' } };
}

function refCodeOf(userId: string): string {
  return userId.replace(/-/g, '').slice(0, 12);
}

test('有効なLeaderプラン契約者の?ref=経由signupは無料memberプランが自動発行される', async ({ request }) => {
  const ts = Date.now();
  const leader = await signup(request, `e2e-autoprovision-leader-${ts}@example.com`);
  await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { user_id: leader.userId, plan: 'leader', status: 'active' },
  });

  const invited = await signup(request, `e2e-autoprovision-invited-${ts}@example.com`, { ref: refCodeOf(leader.userId) });

  const profileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${invited.userId}&select=referred_by`, {
    headers: invited.authHeaders,
  });
  const [profile] = (await profileRes.json()) as { referred_by: string | null }[];
  expect(profile!.referred_by).toBe(leader.userId);

  const subRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${invited.userId}&select=plan,status`, {
    headers: invited.authHeaders,
  });
  const [sub] = (await subRes.json()) as { plan: string; status: string }[];
  expect(sub).toBeTruthy();
  expect(sub!.plan).toBe('member');
  expect(sub!.status).toBe('active');
});

test('Leaderプラン未契約者の?ref=経由signupではmemberプランは自動発行されない', async ({ request }) => {
  const ts = Date.now();
  // 通常のmember(Leaderプランを持たない)を紹介元にする
  const referrer = await signup(request, `e2e-autoprovision-nonleader-${ts}@example.com`);

  const invited = await signup(request, `e2e-autoprovision-notinvited-${ts}@example.com`, { ref: refCodeOf(referrer.userId) });

  const profileRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/profiles?id=eq.${invited.userId}&select=referred_by`, {
    headers: invited.authHeaders,
  });
  const [profile] = (await profileRes.json()) as { referred_by: string | null }[];
  // referred_byの記録自体は紹介元がleaderかどうかによらず行われる(既存の紹介コード機能はそのまま)
  expect(profile!.referred_by).toBe(referrer.userId);

  const subRes = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${invited.userId}&select=plan,status`, {
    headers: invited.authHeaders,
  });
  expect(((await subRes.json()) as unknown[]).length).toBe(0);
});
