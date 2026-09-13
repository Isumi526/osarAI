// 会議録音のアップロード用・署名付きURL発行（T0）。
// 長尺音声は base64 を JSON body に載せると Vercel の body 上限(~4.5MB)を超えるため、
// クライアントは Storage(recordings) へ直接アップロードし、返る path を /api/meeting/ingest に渡す。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { RECORDINGS_BUCKET, ensureRecordingsBucket, extForMime } from '@/lib/recordings-bucket';

export const runtime = 'nodejs';

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const ent = await getEntitlement(supabase, user.id);
  if (!ent.active) return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  // plan が未知（PLANS に無い文字列）ならフェイルクローズ（許可側に倒さない・T7）
  if (!ent.def || !ent.def.recordingImport) {
    return json({ error: 'plan_upgrade_required', message: 'このプランでは会議録音をご利用いただけません。' }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as { mimeType?: string };
  const ext = extForMime(body.mimeType ?? 'audio/webm');
  // パスは必ず user.id 配下（ingest 側の所有者チェックと整合）
  const path = `${user.id}/meetings/${globalThis.crypto.randomUUID()}.${ext}`;

  const admin = createServiceRoleClient();
  await ensureRecordingsBucket(admin);
  const { data, error } = await admin.storage.from(RECORDINGS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return json({ error: 'signed_url_failed', detail: error?.message }, 500);

  return json({ path, token: data.token, signedUrl: data.signedUrl }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
