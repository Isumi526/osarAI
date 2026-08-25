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
import { geminiTranscribeLong, geminiJson, geminiText, GEMINI_MODEL_DIALOGUE, GEMINI_MODEL_LITE } from '@/lib/gemini';
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

  // べき等ガード：同じ録音パスの再送で二重に文字起こし/抽出しない（コスト暴走・重複防止）。
  // 完全な排他には (user_id,audio_url) のユニーク制約が要る（同時実行の競合は残る・📋参照）が、
  // 通常のクライアント再送はこのクエリで吸収する。
  const { data: existingRec } = await supabase
    .from('meeting_recordings')
    .select('id, transcript, minutes, proposals, status')
    .eq('user_id', user.id)
    .eq('audio_url', recordingPath)
    .neq('status', 'failed')
    .maybeSingle();
  if (existingRec) {
    return json(
      {
        meetingId: existingRec.id,
        transcript: existingRec.transcript ?? '',
        minutes: existingRec.minutes ?? null,
        proposals: existingRec.proposals ?? null,
        speakers: parseSpeakers(existingRec.transcript ?? ''),
        reused: true,
      },
      200,
    );
  }

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

  // --- 長尺文字起こし（Files API・話者ラベル付き） ---
  let transcript: string;
  try {
    // PC録音は2chステレオ（左=自分/右=相手）なので self/other を割り当てさせる（T4）。
    transcript = await geminiTranscribeLong(bytes, mimeType, { channelSelfLeft: capture === 'pc_local' });
  } catch (e) {
    return fail(`文字起こしに失敗しました: ${String(e)}`, 502);
  }
  if (!transcript) return fail('文字起こし結果が空でした', 502);
  const speakers = parseSpeakers(transcript);

  // --- 議事録（ペラ一）を生成（T3・失敗しても致命ではない） ---
  let minutes: string | null = null;
  let minutesError: string | null = null;
  try {
    minutes = await geminiText(
      `次の会議の全文文字起こしから、後で見返せる「ペラ一の議事録」を作成してください。` +
        `「要点」「決定事項」「次アクション」を見出し付きで簡潔にまとめ、前置きや解説は付けないでください。` +
        `話者ラベルがあれば誰の発言かも踏まえてください。\n---\n${transcript}\n---`,
      { model: GEMINI_MODEL_LITE, temperature: 0.2 },
    );
  } catch (e) {
    // 致命ではない（議事録なしでも登録は進む）が、失敗は error 列に記録して追跡可能にする。
    minutesError = `議事録生成に失敗しました: ${String(e)}`;
    console.error('[meeting/ingest] minutes failed', e);
  }

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
  let extractError: string | null = null;
  try {
    const result = await geminiJson<TurnResult>(prompt, TURN_SCHEMA, { model: GEMINI_MODEL_DIALOGUE, system: ASSISTANT_SYSTEM_PROMPT });
    extracted = result.extracted ?? {};
  } catch (e) {
    // 文字起こし自体は有用（議事録/レビューに使える）ため残す。ただし抽出失敗を無音で
    // reviewing にせず error 列に記録して観測可能にする（候補は空でレビューに回す）。
    extracted = {};
    extractError = `抽出に失敗しました: ${String(e)}`;
    console.error('[meeting/ingest] extract failed', e);
  }
  const proposals = toProposals(extracted, customers, now);

  await supabase
    .from('meeting_recordings')
    .update({
      transcript,
      minutes,
      proposals: proposals as unknown as never,
      status: 'reviewing',
      error: [extractError, minutesError].filter(Boolean).join(' / ') || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', meetingId);

  return json({ meetingId, transcript, minutes, proposals, speakers }, 200);
}

/** 文字起こしの行頭ラベルから話者ロスターを作る（T4）。「自分」は isSelf=true。 */
function parseSpeakers(transcript: string): { label: string; isSelf: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const line of transcript.split('\n')) {
    const m = /^\s*(自分|相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：]/.exec(line);
    if (!m) continue;
    const label = m[1]!.replace(/\s+/g, '');
    seen.set(label, label === '自分');
  }
  return [...seen.entries()].map(([label, isSelf]) => ({ label, isSelf }));
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
