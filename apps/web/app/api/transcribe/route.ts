// 録音取り込み（サブ経路・§8-2 / F-03）。
// モバイルが録れた音声(base64)を送る → サーバーが Storage(recordings) に保存 →
// Gemini で文字起こし → 要約(ai_summary) → interactions(source=録音種別) を作成。
// 音声は service_role で保存（非公開バケット）。interaction はユーザーのRLSクライアントで作成。
import { NextResponse } from 'next/server';
import type { AiSummary, InteractionSource, OsaraiExtracted } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { geminiTranscribe, geminiJson, GEMINI_MODEL_LITE, type GeminiSchema } from '@/lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 120;

const BUCKET = 'recordings';

// 録音は対面/Zoomの2種（§6 interactions.source）。UI から来た値を検証。
const REC_SOURCES: InteractionSource[] = ['in_person_rec', 'zoom_rec'];

const SUMMARY_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    points: { type: 'array', items: { type: 'string' } },
    needs: { type: 'array', items: { type: 'string' } },
    next_actions: { type: 'array', items: { type: 'string' } },
    temperature: { type: 'string', enum: ['hot', 'warm', 'cold'], nullable: true },
  },
  required: ['points', 'needs', 'next_actions'],
};

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json()) as {
    customerId?: string;
    audioBase64?: string;
    mimeType?: string;
    source?: InteractionSource;
  };
  const customerId = body.customerId;
  const audioBase64 = body.audioBase64 ?? '';
  const mimeType = body.mimeType ?? 'audio/webm';
  const source: InteractionSource = REC_SOURCES.includes(body.source as InteractionSource)
    ? (body.source as InteractionSource)
    : 'in_person_rec';
  if (!customerId) return json({ error: 'customerId required' }, 400);
  if (!audioBase64) return json({ error: 'audioBase64 required' }, 400);

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) return json({ error: 'profile not found' }, 400);
  const orgId = profile.org_id;

  // 対象顧客が自分のものか（RLSで見えるか）確認
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .maybeSingle();
  if (!customer) return json({ error: 'customer not found' }, 404);

  // --- Storage へ保存（service_role・非公開） ---
  const admin = createServiceRoleClient();
  await ensureBucket(admin);
  const ext = extForMime(mimeType);
  const path = `${user.id}/${customerId}/${cryptoRandom()}.${ext}`;
  const bytes = Buffer.from(audioBase64, 'base64');
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (upErr) return json({ error: 'upload failed', detail: upErr.message }, 500);

  // --- 文字起こし + 要約 ---
  let transcript: string;
  try {
    transcript = await geminiTranscribe(audioBase64, mimeType);
  } catch (e) {
    return json({ error: 'transcribe failed', detail: String(e) }, 502);
  }

  let summary: AiSummary = { points: [], needs: [], next_actions: [] };
  let temperature: OsaraiExtracted['temperature'] = null;
  if (transcript) {
    try {
      const s = await geminiJson<AiSummary & { temperature?: OsaraiExtracted['temperature'] }>(
        `次の商談メモ（文字起こし）を要約してください。\n---\n${transcript}\n---`,
        SUMMARY_SCHEMA,
        { model: GEMINI_MODEL_LITE, temperature: 0.2 },
      );
      summary = { points: s.points ?? [], needs: s.needs ?? [], next_actions: s.next_actions ?? [] };
      temperature = s.temperature ?? null;
    } catch {
      // 要約失敗時も transcript は残す（要約なしで interaction 作成）
    }
  }

  // --- interaction 作成（ユーザーのRLSクライアント・author_id=自分） ---
  const now = new Date().toISOString();
  const { data: interaction, error: ixErr } = await supabase
    .from('interactions')
    .insert({
      org_id: orgId,
      customer_id: customerId,
      author_id: user.id,
      source,
      type: 'audio',
      audio_url: path,
      transcript,
      ai_summary: summary as never,
      met_at: now,
    })
    .select('id')
    .single();
  if (ixErr || !interaction) return json({ error: 'interaction create failed' }, 500);

  // 顧客カード更新（温度感/最終接触。needs は要約があれば補完）
  await supabase
    .from('customers')
    .update({
      last_met_at: now,
      updated_at: now,
      ...(temperature ? { temperature } : {}),
      ...(summary.needs.length ? { needs: summary.needs.join(' / ') } : {}),
    })
    .eq('id', customerId);

  return json({ interactionId: interaction.id, transcript, summary }, 200);
}

async function ensureBucket(admin: ReturnType<typeof createServiceRoleClient>) {
  const { data } = await admin.storage.getBucket(BUCKET);
  if (!data) {
    await admin.storage.createBucket(BUCKET, { public: false });
  }
}

function extForMime(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

// crypto.randomUUID は Node/Edge 双方で利用可
function cryptoRandom(): string {
  return globalThis.crypto.randomUUID();
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
