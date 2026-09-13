// 会議録音の確定登録（T0）。ユーザーが確認カードで編集した最終版 proposals を受け取り、
// 既存 commitProposals（つながり/interactions/schedules/tasks を名寄せ込みで書き込む）を再利用する。
// 統合AIチャットの /api/assistant/commit と同じ規律。会議録音は meeting_recordings を done にする。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { commitProposals, type Proposals } from '@/lib/assistant-persist';
import { getEntitlement } from '@/lib/entitlement';
import { relabelSpeakers } from '@/lib/meeting-speakers';

export const runtime = 'nodejs';
export const maxDuration = 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json().catch(() => ({}))) as {
    meetingId?: string;
    proposals?: Proposals;
    minutes?: string | null;
    speakerNames?: Record<string, string>;
  };
  const meetingId = (body.meetingId ?? '').trim();
  const proposals = body.proposals;
  if (!meetingId) return json({ error: 'meetingId required' }, 400);
  if (!proposals) return json({ error: 'proposals required' }, 400);

  // 新規のつながりは名前が必須（/api/assistant/commit と同じサーバー側検証・T7）
  const unnamed = proposals.people.find((p) => !p.customer_id && !p.name?.trim());
  if (unnamed) return json({ error: 'name_required', message: 'お名前が未入力のつながりがあります。' }, 400);

  const [{ data: profile }, ent] = await Promise.all([
    supabase.from('profiles').select('org_id').eq('id', user.id).maybeSingle(),
    getEntitlement(supabase, user.id),
  ]);
  if (!profile) return json({ error: 'profile not found' }, 400);
  if (!ent.active) return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  const orgId = profile.org_id;

  // 対象録音（本人のもの・RLSで保証されるが status も確認）。
  // reviewing 以外は受け付けない: processing/failed の行を空 proposals で done にすると二度と直せなくなる。
  const { data: rec, error: recErr } = await supabase
    .from('meeting_recordings')
    .select('id, transcript, status, capture, duration_sec, created_at')
    .eq('id', meetingId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (recErr || !rec) return json({ error: 'meeting not found' }, 404);
  if (rec.status === 'done') return json({ error: 'already_committed', message: 'この録音はすでに登録済みです。' }, 409);
  if (rec.status !== 'reviewing') {
    return json({ error: 'not_reviewable', message: 'この録音はまだ解析が終わっていません（再解析してください）。' }, 409);
  }
  // 会議の実施日時 ＝ 録音行の作成時刻 − 録音時間（承認が翌日にずれても会議日を保つ）
  const metAt = new Date(Date.parse(rec.created_at) - (rec.duration_sec ?? 0) * 1000).toISOString();
  const source = rec.capture === 'mobile_speaker' ? 'in_person_rec' : 'zoom_rec';

  // 話者ラベル（自分/相手1…）を、ユーザーが割り当てた実名に置き換える（T4）。
  // transcript も議事録も同じ置換を通し、履歴で「誰が話したか」が実名で読めるようにする。
  const speakerNames = body.speakerNames ?? {};
  const transcript = relabelSpeakers(rec.transcript ?? '', speakerNames);
  const minutes = body.minutes ? relabelSpeakers(body.minutes, speakerNames) : null;

  let result;
  try {
    result = await commitProposals({
      supabase,
      orgId,
      userId: user.id,
      proposals,
      transcript,
      minutes,
      source,
      metAt,
    });
  } catch (e) {
    return json({ error: 'commit_failed', detail: String(e) }, 500);
  }

  // 最初に紐付いた相手を録音の customer_id に残す（タイムラインの入口用）。
  // 実名化した transcript/議事録も録音レコードへ反映する。
  const primaryCustomerId = result.customers[0]?.id ?? null;
  await supabase
    .from('meeting_recordings')
    .update({
      status: 'done',
      customer_id: primaryCustomerId,
      transcript,
      minutes,
      committed_interaction_ids: result.interactionIds as unknown as never,
      updated_at: new Date().toISOString(),
    })
    .eq('id', meetingId)
    .eq('user_id', user.id);

  return json({ meetingId, ...result }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
