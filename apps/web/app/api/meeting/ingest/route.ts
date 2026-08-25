// 会議録音の取り込み（T0・録音ソース非依存の共通バックエンド）。
// クライアントが Storage(recordings) にアップロード済みの音声パスを受け取り、
//   長尺文字起こし(Files API) → 全文から people/schedules/tasks を1ショット抽出 →
//   meeting_recordings に状態保存 → 承認用の proposals を返す。
// 承認後の登録は /api/meeting/commit（既存 commitProposals を再利用）。
// 抽出スキーマ/整形は lib/proposal-extraction を共有（統合AIチャットと同一ロジック）。
import { NextResponse } from 'next/server';
import { buildAssistantPrompt, ASSISTANT_SYSTEM_PROMPT } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { formatUserProfile } from '@/lib/customer-context';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { RECORDINGS_BUCKET } from '@/lib/recordings-bucket';
import { geminiTranscribeLong, geminiJson, GEMINI_MODEL_DIALOGUE } from '@/lib/gemini';
import { TURN_SCHEMA, toProposals, type Extracted, type TurnResult } from '@/lib/proposal-extraction';

export const runtime = 'nodejs';
// 長尺文字起こし(アップロード＋processing待ち＋生成)＋抽出を同期で行う。Vercel上限に合わせる。
// 30分級を超える会議は将来バックグラウンドジョブ化する（📋参照）。
export const maxDuration = 300;

const CAPTURES = ['pc_local', 'mobile_speaker', 'bot'] as const;
type Capture = (typeof CAPTURES)[number];

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json().catch(() => ({}))) as {
    recordingPath?: string;
    mimeType?: string;
    capture?: Capture;
    durationSec?: number;
    consentAck?: boolean;
  };
  const recordingPath = (body.recordingPath ?? '').trim();
  const mimeType = body.mimeType ?? 'audio/webm';
  const capture: Capture = CAPTURES.includes(body.capture as Capture) ? (body.capture as Capture) : 'pc_local';
  if (!recordingPath) return json({ error: 'recordingPath required' }, 400);
  // 所有者チェック（他人のパスを読ませない）。パスは必ず user.id 配下。
  if (!recordingPath.startsWith(`${user.id}/`)) return json({ error: 'forbidden path' }, 403);

  const [ent, profileRes] = await Promise.all([
    getEntitlement(supabase, user.id),
    supabase.from('profiles').select('org_id, user_profile').eq('id', user.id).maybeSingle(),
  ]);
  if (!ent.active) return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  if (ent.def && !ent.def.recordingImport) {
    return json({ error: 'plan_upgrade_required', message: '会議録音は Standard 以上でご利用いただけます。' }, 403);
  }
  const profile = profileRes.data;
  if (!profile) return json({ error: 'profile not found' }, 400);
  const orgId = profile.org_id;

  // --- 録音レコードを作成（処理中） ---
  const { data: rec, error: recErr } = await supabase
    .from('meeting_recordings')
    .insert({
      org_id: orgId,
      user_id: user.id,
      capture,
      audio_url: recordingPath,
      mime_type: mimeType,
      duration_sec: typeof body.durationSec === 'number' ? Math.round(body.durationSec) : null,
      consent_ack: body.consentAck === true,
      status: 'processing',
    })
    .select('id')
    .single();
  if (recErr || !rec) return json({ error: 'meeting create failed', detail: recErr?.message }, 500);
  const meetingId = rec.id;

  const fail = async (detail: string, status: number) => {
    await supabase.from('meeting_recordings').update({ status: 'failed', error: detail, updated_at: new Date().toISOString() }).eq('id', meetingId);
    return json({ error: 'ingest_failed', meetingId, detail }, status);
  };

  // --- Storage から音声を取得（service_role・非公開バケット） ---
  const admin = createServiceRoleClient();
  const { data: blob, error: dlErr } = await admin.storage.from(RECORDINGS_BUCKET).download(recordingPath);
  if (dlErr || !blob) return fail(`音声の取得に失敗しました: ${dlErr?.message ?? 'not found'}`, 404);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // --- 長尺文字起こし（Files API） ---
  let transcript: string;
  try {
    transcript = await geminiTranscribeLong(bytes, mimeType);
  } catch (e) {
    return fail(`文字起こしに失敗しました: ${String(e)}`, 502);
  }
  if (!transcript) return fail('文字起こし結果が空でした', 502);

  // --- 全文から people/schedules/tasks を1ショット抽出 ---
  const [customersRes, agencyRes] = await Promise.all([
    supabase.from('customers').select('id, name, relation_type, needs').eq('owner_id', user.id).eq('status', 'active').limit(100),
    supabase.from('agency_products').select('name').limit(50),
  ]);
  const customers = customersRes.data ?? [];
  const customerRoster = customers
    .map((c) => `- id=${c.id} 名前=${c.name}${c.relation_type ? ` 区分=${c.relation_type}` : ''}${c.needs ? ` ニーズ=${c.needs}` : ''}`)
    .join('\n');
  const userProfile = (profile.user_profile as Record<string, unknown> | null) ?? {};
  const ownProducts = Array.isArray(userProfile.products)
    ? (userProfile.products as { name?: string }[]).map((p) => p?.name).filter(Boolean)
    : [];
  const productRoster = [...ownProducts, ...(agencyRes.data ?? []).map((p) => p.name)].map((n) => `- ${n}`).join('\n');
  const notes = Array.isArray(userProfile.notes) ? (userProfile.notes as string[]).slice(-30) : [];
  const userContext = [formatUserProfile(userProfile), notes.length ? `これまでの気づき:\n${notes.map((n) => `- ${n}`).join('\n')}` : '']
    .filter(Boolean)
    .join('\n');

  const now = new Date();
  const nowLabel = now.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  // 会議の全文文字起こしを「対話履歴」枠に流し込む。ユーザー本人が参加した会議として、
  // 登場人物(相手)・発生した予定・タスクを抽出させる。返答(reply)は使わない。
  const history =
    `以下はユーザーが参加した会議の全文文字起こしです。ここから、会話に登場した相手（ユーザー本人以外）と、` +
    `会議で決まった予定・発生したタスクを抽出してください。ユーザー本人を people に含めないでください。\n---\n${transcript}\n---`;
  const prompt = buildAssistantPrompt({ now: nowLabel, customerRoster, productRoster, userContext, history });

  let extracted: Extracted;
  try {
    const result = await geminiJson<TurnResult>(prompt, TURN_SCHEMA, { model: GEMINI_MODEL_DIALOGUE, system: ASSISTANT_SYSTEM_PROMPT });
    extracted = result.extracted ?? {};
  } catch (e) {
    // 文字起こしは残す（抽出だけ失敗）。空proposalsでレビューへ回す。
    extracted = {};
    await supabase.from('meeting_recordings').update({ transcript, updated_at: new Date().toISOString() }).eq('id', meetingId);
    console.error('[meeting/ingest] extract failed', e);
  }
  const proposals = toProposals(extracted, customers, now);

  await supabase
    .from('meeting_recordings')
    .update({
      transcript,
      proposals: proposals as unknown as never,
      status: 'reviewing',
      updated_at: new Date().toISOString(),
    })
    .eq('id', meetingId);

  return json({ meetingId, transcript, proposals }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
