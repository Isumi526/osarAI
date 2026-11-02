// 会議の音声を聞き返す・消す（録音の保存方針・2026-11-02）。
// 方針：契約中は音声を残し、会議ごとにいつでも消せる。解約から90日で自動削除（cron/audio-retention）、
// 退会で即削除（api/account/delete）。音声は非公開バケットにあるので、聞く時だけ短命の署名付きURLを出す。
// POST { action: 'url' }    → { tracks: [{ label, url }] }（2トラック録音なら相手側・自分側の2本）
// POST { action: 'delete' } → Storage から消し、audio_url / self_audio_url を空にする
// CORS の許可メソッドが POST のみ（lib/api-auth）なので、どちらも POST で受ける。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { RECORDINGS_BUCKET } from '@/lib/recordings-bucket';

export const runtime = 'nodejs';

/** 署名付きURLの有効期限（秒）。画面を開いている間に聞ければよい */
const SIGNED_URL_TTL = 60 * 30;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authedFromRequest(req);
  if (!auth) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = auth;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string };

  // 本人の会議か（RLS つきのクライアントで引く）
  const { data: rec } = await supabase
    .from('meeting_recordings')
    .select('id, audio_url, self_audio_url')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!rec) return json({ error: 'meeting not found' }, 404);

  // パスは必ず本人の配下だけを扱う（行の値が壊れていても他人のファイルに触れない）
  const own = (p: string | null): p is string => !!p && p.startsWith(`${user.id}/`);
  const admin = createServiceRoleClient();

  if (body.action === 'url') {
    const tracks: { label: string; url: string }[] = [];
    const pairs: [string, string | null][] = rec.self_audio_url
      ? [['相手側', rec.audio_url], ['自分側', rec.self_audio_url]]
      : [['録音', rec.audio_url]];
    for (const [label, path] of pairs) {
      if (!own(path)) continue;
      const { data } = await admin.storage.from(RECORDINGS_BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
      if (data?.signedUrl) tracks.push({ label, url: data.signedUrl });
    }
    return json({ tracks }, 200);
  }

  if (body.action === 'delete') {
    const paths = [rec.audio_url, rec.self_audio_url].filter(own);
    if (paths.length > 0) {
      const { error } = await admin.storage.from(RECORDINGS_BUCKET).remove(paths);
      if (error) return json({ error: 'storage_delete_failed', message: '音声を消せませんでした。時間をおいてもう一度お試しください。' }, 500);
    }
    // 音声のパスは消すが、行は残す（議事録・文字起こしはそのまま。ingest の再送ガードは audio_url で引くので、
    // 消した後に同じパスが再送されても既存行には当たらない＝ファイルが無いので処理は失敗で終わる）
    await supabase
      .from('meeting_recordings')
      .update({ audio_url: null, self_audio_url: null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id);
    return json({ ok: true }, 200);
  }

  return json({ error: 'unknown action' }, 400);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
