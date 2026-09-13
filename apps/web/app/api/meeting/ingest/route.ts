// 会議録音の取り込み（T0・録音ソース非依存の共通バックエンド）。
// クライアントが Storage(recordings) にアップロード済みの音声パスを受け取り、
//   長尺文字起こし(Files API) → 全文から people/schedules/tasks を1ショット抽出 →
//   meeting_recordings に状態保存 → 承認用の proposals を返す。
// 承認後の登録は /api/meeting/commit（既存 commitProposals を再利用）。
// 抽出スキーマ/整形は lib/proposal-extraction を共有（統合AIチャットと同一ロジック）。
import { NextResponse } from 'next/server';
import { buildAssistantPrompt, ASSISTANT_SYSTEM_PROMPT, buildMeetingMinutesPrompt } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { formatUserProfile } from '@/lib/customer-context';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { RECORDINGS_BUCKET } from '@/lib/recordings-bucket';
import { geminiTranscribeLong, geminiJson, geminiText, GEMINI_MODEL_DIALOGUE, GEMINI_MODEL_LITE } from '@/lib/gemini';
import { TURN_SCHEMA, toProposals, type Extracted, type TurnResult } from '@/lib/proposal-extraction';
import { parseSpeakers } from '@/lib/meeting-speakers';

export const runtime = 'nodejs';
// 長尺文字起こし(アップロード＋processing待ち＋生成)＋抽出を同期で行う。Vercel上限に合わせる。
// 1時間級の会議は本番実測のうえ段階実行に移す（T8）。それまでの暫定として、
// クライアント側の再試行（同一 recordingPath の再送＝べき等）と stale 回収で取りこぼしを防ぐ（T7）。
export const maxDuration = 300;
/** status='processing' のままこの時間を超えた行は、関数が打ち切られた残骸とみなして再処理する。 */
const STALE_PROCESSING_MS = 15 * 60 * 1000;

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
    supabase.from('profiles').select('org_id, user_profile, display_name').eq('id', user.id).maybeSingle(),
  ]);
  if (!ent.active) return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  // plan が未知（PLANS に無い文字列）ならフェイルクローズ（T7）
  if (!ent.def || !ent.def.recordingImport) {
    return json({ error: 'plan_upgrade_required', message: 'このプランでは会議録音をご利用いただけません。' }, 403);
  }
  const profile = profileRes.data;
  if (!profile) return json({ error: 'profile not found' }, 400);
  const orgId = profile.org_id;

  // べき等ガード：同じ録音パスの再送で二重に文字起こし/抽出しない（コスト暴走・重複防止）。
  // 完全な排他には (user_id,audio_url) のユニーク制約が要る（同時実行の競合は残る・📋参照）が、
  // 通常のクライアント再送はこのクエリで吸収する。
  // - reviewing/done: 保存済みの結果をそのまま返す（reused）
  // - processing で新しい: まだ前回の処理が走っている可能性があるので待ってもらう（409）
  // - processing で古い(15分超): Vercel の打ち切り等で残った残骸とみなし、同じ行を再処理する
  // - failed: 再処理（新しい行は作らず同じ行を使う）
  const { data: existingRec } = await supabase
    .from('meeting_recordings')
    .select('id, transcript, minutes, proposals, status, updated_at, error')
    .eq('user_id', user.id)
    .eq('audio_url', recordingPath)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let meetingId: string;
  if (existingRec && (existingRec.status === 'reviewing' || existingRec.status === 'done')) {
    return json(
      {
        meetingId: existingRec.id,
        transcript: existingRec.transcript ?? '',
        minutes: existingRec.minutes ?? null,
        proposals: existingRec.proposals ?? null,
        speakers: parseSpeakers(existingRec.transcript ?? ''),
        warnings: existingRec.error ? [existingRec.error] : [],
        reused: true,
      },
      200,
    );
  }
  if (existingRec && existingRec.status === 'processing') {
    const age = Date.now() - Date.parse(existingRec.updated_at);
    if (age < STALE_PROCESSING_MS) {
      return json(
        { error: 'still_processing', meetingId: existingRec.id, message: 'この録音は解析中です。しばらく待ってから「再解析」を押してください。' },
        409,
      );
    }
  }
  if (existingRec) {
    // failed / stale processing → 同じ行を再利用して再処理
    meetingId = existingRec.id;
    await supabase
      .from('meeting_recordings')
      .update({ status: 'processing', error: null, updated_at: new Date().toISOString() })
      .eq('id', meetingId);
  } else {
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
    meetingId = rec.id;
  }

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

  // --- 全文から people/schedules/tasks を1ショット抽出 ---
  const [customersRes, agencyRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, name, relation_type, needs')
      .eq('owner_id', user.id)
      .eq('status', 'active')
      // 直近に会った人から名簿に載せる（100件超のユーザーで名寄せ対象が不定にならないように）
      .order('last_met_at', { ascending: false, nullsFirst: false })
      .limit(100),
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
  // --- 議事録（固定セクション型・T3/T7）。失敗しても致命ではない（候補は出す） ---
  let minutes: string | null = null;
  let minutesError: string | null = null;
  const durationSec = typeof body.durationSec === 'number' ? Math.round(body.durationSec) : null;
  const meetingStart = durationSec ? new Date(now.getTime() - durationSec * 1000) : now;
  const meetingAtLabel = meetingStart.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  try {
    minutes = await geminiText(
      buildMeetingMinutesPrompt({
        meetingAt: meetingAtLabel,
        duration: durationSec ? `${Math.max(1, Math.round(durationSec / 60))}分` : '',
        transcript,
        userContext: formatUserProfile(userProfile),
      }),
      // 1時間分の文字起こしが入力になるため、対話用の既定15秒では足りない
      { model: GEMINI_MODEL_LITE, temperature: 0.2, timeoutMs: 90_000 },
    );
  } catch (e) {
    // 致命ではない（議事録なしでも登録は進む）が、失敗は error 列とレスポンス warnings で観測可能にする。
    minutesError = `議事録の生成に失敗しました: ${String(e)}`;
    console.error('[meeting/ingest] minutes failed', e);
  }

  // 会議の全文文字起こしを「対話履歴」枠に流し込む。ユーザー本人が参加した会議として、
  // 登場人物(相手)・発生した予定・タスクを抽出させる。返答(reply)は使わない。
  const selfName = (profile.display_name ?? '').trim();
  const history =
    `以下はユーザーが参加した会議の全文文字起こしです。ここから、実際に会話に参加した相手（ユーザー本人以外）と、` +
    `会議で決まった予定・発生したタスクを抽出してください。` +
    `ユーザー本人${selfName ? `（名前: ${selfName}。「自分:」の発言者）` : '（「自分:」の発言者）'}を people に含めないでください。` +
    `話の中で名前だけ出た第三者（紹介したい知人など）は people に入れず、必要なら tasks の題名に含めてください。` +
    `相手の名前が分からない場合は name を空文字にしてください（「相手1」のようなラベルを名前にしない）。` +
    `\n---\n${transcript}\n---`;
  const prompt = buildAssistantPrompt({ now: nowLabel, customerRoster, productRoster, userContext, history });

  let extracted: Extracted;
  let extractError: string | null = null;
  try {
    const result = await geminiJson<TurnResult>(prompt, TURN_SCHEMA, {
      model: GEMINI_MODEL_DIALOGUE,
      system: ASSISTANT_SYSTEM_PROMPT,
      timeoutMs: 120_000,
    });
    extracted = result.extracted ?? {};
  } catch (e) {
    // 文字起こし自体は有用（議事録/レビューに使える）ため残す。ただし抽出失敗を無音で
    // reviewing にせず error 列に記録して観測可能にする（候補は空でレビューに回す）。
    extracted = {};
    extractError = `候補の抽出に失敗しました: ${String(e)}`;
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

  const warnings = [extractError, minutesError].filter((w): w is string => !!w);
  return json({ meetingId, transcript, minutes, proposals, speakers, warnings }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
