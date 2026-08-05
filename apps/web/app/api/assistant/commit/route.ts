// 統合AIチャットの確定保存（2026-08-06 UI/UX刷新）。
// ユーザーが確認カードで編集した最終版だけをここで書き込む（AIには保存させない＝誤登録防止）。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { commitProposals, type Proposals } from '@/lib/assistant-persist';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json()) as { sessionId?: string; proposals?: Proposals };
  if (!body.sessionId || !body.proposals) return json({ error: 'sessionId and proposals required' }, 400);

  const [ent, profileRes, sessionRes] = await Promise.all([
    getEntitlement(supabase, user.id),
    supabase.from('profiles').select('org_id').eq('id', user.id).maybeSingle(),
    supabase
      .from('assistant_sessions')
      .select('id, messages, status')
      .eq('id', body.sessionId)
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);
  if (!ent.active) return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  const profile = profileRes.data;
  if (!profile) return json({ error: 'profile not found' }, 400);
  const session = sessionRes.data;
  if (!session) return json({ error: 'session not found' }, 404);
  if (session.status === 'done') return json({ error: 'session already committed' }, 409);

  // 新規つながりは名前が無いと後で見分けられない（Osarai.tsx の必須バリデーションと同じ規律）
  const unnamed = (body.proposals.people ?? []).find((p) => !p.customer_id && !p.name?.trim());
  if (unnamed) return json({ error: 'name required', message: 'お名前が未入力のつながりがあります' }, 400);

  const transcript = ((session.messages as ChatMessage[]) ?? [])
    .map((m) => `${m.role === 'user' ? 'あなた' : 'AI'}: ${m.content}`)
    .join('\n');

  let result;
  try {
    result = await commitProposals({
      supabase,
      orgId: profile.org_id,
      userId: user.id,
      proposals: body.proposals,
      transcript,
    });
  } catch (e) {
    return json({ error: 'commit failed', detail: String(e instanceof Error ? e.message : e) }, 500);
  }

  await supabase
    .from('assistant_sessions')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', session.id)
    .eq('user_id', user.id);

  return json(result, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
