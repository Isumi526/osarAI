import { test, expect } from '@playwright/test';
import { splitCardNote } from '@osarai/shared';

// 2026-11-05 人判断「AI も書き足す」（0036）。会うたびに、カードのメモへ新しく分かったことだけを足し、
// タイムライン（interactions.summary）と同じ文を重ねない。
// 1本目は保存直前の決定的な切り分け、2本目は実際の Gemini で2回会った流れを通す。

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SERVICE_KEY = 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };

test('splitCardNote: 既存メモにある行は足さず、カードと同じ行は要約から除く', () => {
  const { additions, summary } = splitCardNote({
    existing: '保険代理店を経営している\n娘が2人いる',
    cardNote: '保険代理店を経営している。\n週末はサーフィンをする\n娘が二人いる（中学生）',
    memo: '来月の交流会の話をした\n週末はサーフィンをする',
  });
  expect(additions).toBe('週末はサーフィンをする\n娘が二人いる（中学生）');
  expect(summary).toBe('来月の交流会の話をした');
});

test('splitCardNote: 今回足す行の言い換えは要約から除くが、既存メモに近いだけの進展は残す', () => {
  const { additions, summary } = splitCardNote({
    existing: '子どもは小学2年生',
    cardNote: '来春に川崎で2店舗目をオープン予定',
    memo: '来春に川崎へ2店舗目を出す予定とのこと。\n子どもは小学3年生になった\n息子と釣りに行けていない',
  });
  expect(additions).toBe('来春に川崎で2店舗目をオープン予定');
  expect(summary).toBe('子どもは小学3年生になった\n息子と釣りに行けていない');
});

test('splitCardNote: 短い既存行に、より詳しい新情報が吸われない', () => {
  const { additions } = splitCardNote({ existing: '保険', cardNote: '保険代理店を20年経営している', memo: '' });
  expect(additions).toBe('保険代理店を20年経営している');
});

test('2回会うと、カードのメモには新しいことだけが増え、タイムラインと同じ文が重ならない', async ({ request }) => {
  test.setTimeout(240_000); // 実Gemini呼び出しを複数ターン行うため

  const email = `e2e-card-memo-${Date.now()}@example.com`;
  const signupRes = await request.post(`${LOCAL_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: LOCAL_ANON_KEY, 'content-type': 'application/json' },
    data: { email, password: 'testpassword123' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const { user, access_token } = (await signupRes.json()) as { user: { id: string }; access_token: string };
  await request.post(`${LOCAL_SUPABASE_URL}/rest/v1/subscriptions`, {
    headers: { ...svc, Prefer: 'return=representation' },
    data: { user_id: user.id, plan: 'standard', status: 'trialing' },
  });
  const authHeaders = { Authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };

  const session = async (customerId: string | null, message: string) => {
    const res = await request.post('/api/osarai/turn', {
      headers: authHeaders,
      data: { customerId, message, remainingSec: 240 },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { sessionId: string; customerId: string | null; done: boolean };
    if (body.done) return body.customerId!;
    const end = await request.post('/api/osarai/turn', {
      headers: authHeaders,
      data: { message: '', sessionId: body.sessionId, forceEnd: true },
    });
    expect(end.ok()).toBeTruthy();
    return ((await end.json()) as { customerId: string }).customerId;
  };
  const card = async (id: string) => {
    const res = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/customers?id=eq.${id}&select=profile_notes`, { headers: { ...svc } });
    return ((await res.json()) as { profile_notes: string | null }[])[0]!.profile_notes ?? '';
  };
  const summaries = async (id: string) => {
    const res = await request.get(`${LOCAL_SUPABASE_URL}/rest/v1/interactions?customer_id=eq.${id}&select=summary`, { headers: { ...svc } });
    return ((await res.json()) as { summary: string | null }[]).map((r) => r.summary ?? '');
  };

  const name = `テスト四郎${Date.now()}`;
  const id = await session(
    null,
    `${name}さんと会った。不動産の仕事をしていて、娘さんが2人いるそうだ。来月の交流会に一緒に行く約束をした。`,
  );
  const first = await card(id);
  expect(first).toContain('不動産');

  await session(id, '今日もその人と会った。不動産の仕事は相変わらず忙しいらしい。最近、趣味でサーフィンを始めたそうだ。交流会の日程を決めた。');
  const second = await card(id);
  expect(second.startsWith(first)).toBeTruthy(); // 既存のメモは書き換えない（追記だけ）
  expect(second).toContain('サーフィン');
  expect(second.match(/不動産/g)?.length).toBe(first.match(/不動産/g)?.length); // 既知のことは足さない

  const cardLines = new Set(second.split('\n').map((l) => l.trim()).filter(Boolean));
  for (const s of await summaries(id)) {
    for (const line of s.split('\n').map((l) => l.trim()).filter(Boolean)) expect(cardLines.has(line)).toBeFalsy();
  }
});
