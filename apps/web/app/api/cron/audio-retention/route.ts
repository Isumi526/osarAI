// 解約から90日たった利用者の録音音声を消す（毎日1回・Vercel Cron。録音の保存方針・2026-11-02）。
// 「解約から」の起点は、使える期間が終わった日（current_period_end。無ければ最後に更新された日）。
// 議事録・文字起こし・相手の情報は消さない（プライバシーポリシーの保存期間の書き方に合わせる）。
// 何度動いても同じ結果になる（消すものが無ければ何もしない）ので、cron_runs の二重起動ガードは置かない。
// T10#4: cron/スケジューラは共有シークレットヘッダ必須。secret未設定時の素通しフォールバック禁止。
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { removeUserRecordings } from '@/lib/recordings-bucket';

export const runtime = 'nodejs';

const RETENTION_DAYS = 90;
/** 契約が終わったとみなす Stripe の状態 */
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = createServiceRoleClient();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: subs, error } = await db
    .from('subscriptions')
    .select('user_id, current_period_end, updated_at')
    .in('status', ENDED_STATUSES);
  if (error) return NextResponse.json({ error: 'subscriptions query failed' }, { status: 500 });

  const expired = (subs ?? []).filter((s) => (s.current_period_end ?? s.updated_at) < cutoff);
  let users = 0;
  let files = 0;
  const failures: string[] = [];
  for (const s of expired) {
    try {
      const n = await removeUserRecordings(db, s.user_id);
      await db
        .from('meeting_recordings')
        .update({ audio_url: null, self_audio_url: null })
        .eq('user_id', s.user_id)
        .or('audio_url.not.is.null,self_audio_url.not.is.null');
      if (n > 0) users += 1;
      files += n;
    } catch {
      failures.push(s.user_id); // 次の日にもう一度試す
    }
  }
  return NextResponse.json({ checked: expired.length, users, files, failed: failures.length });
}
