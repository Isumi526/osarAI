// 会議録音の事後編集（T7c・承認ステップ廃止に伴い「保存後に直す」経路）。
// PATCH: 議事録(minutes)の更新。meeting_recordings と、紐付いた interactions.ai_summary.minutes の両方に反映する。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import type { AiSummary } from '@osarai/shared';

export const runtime = 'nodejs';

export function OPTIONS() {
  return corsPreflight();
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authedFromRequest(req);
  if (!auth) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = auth;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { minutes?: string };
  if (typeof body.minutes !== 'string') return json({ error: 'minutes required' }, 400);
  const minutes = body.minutes.trim().slice(0, 20_000);

  const { data: rec } = await supabase
    .from('meeting_recordings')
    .select('id, committed_interaction_ids')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!rec) return json({ error: 'meeting not found' }, 404);

  await supabase.from('meeting_recordings').update({ minutes, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', user.id);

  const ids = Array.isArray(rec.committed_interaction_ids) ? (rec.committed_interaction_ids as string[]) : [];
  for (const ixId of ids) {
    const { data: ix } = await supabase.from('interactions').select('ai_summary').eq('id', ixId).maybeSingle();
    if (!ix) continue;
    const summary = ((ix.ai_summary as AiSummary | null) ?? { points: [], needs: [], next_actions: [] }) as AiSummary;
    if (!summary.minutes) continue; // 議事録が付いていない相手の履歴は触らない
    await supabase
      .from('interactions')
      .update({ ai_summary: { ...summary, minutes } as never })
      .eq('id', ixId);
  }
  return json({ ok: true }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
