// スケジュール終了時刻の「おさらいしませんか」通知（§14後追加・スケジュール管理機能）。
// Vercel Cronから短い間隔(例: 5〜15分毎)で呼ばれる想定。終了時刻を過ぎたばかりの
// 未通知(reminded_at is null)スケジュールを検出し、その所有者へpushする。
// 他のcron(remind/action-suggest)はjob+日付でdedupするが、本ジョブは対象がスケジュール単位で
// 1日に何度も終わるため、schedules.reminded_at 自体を冪等化マーカーとして使う。
// 送信成功を確認してから既読化する(送信前クレームだと送信失敗時に通知が失われるため)。
// at-least-once実行による稀な重複送信より、通知の取りこぼしを避けることを優先している。
import { NextResponse } from 'next/server';
import { sendPush } from '@/lib/push-fcm';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// 実行間隔より広めに取った検出ウィンドウ（cronの遅延・リトライを吸収）。
const WINDOW_MINUTES = 30;

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
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data: due, error: dueError } = await db
    .from('schedules')
    .select('id, owner_id, title, end_at')
    .is('reminded_at', null)
    .lte('end_at', now.toISOString())
    .gte('end_at', windowStart);
  if (dueError) {
    return NextResponse.json({ error: 'query failed' }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ targeted: 0, sent: 0, failed: 0 });
  }

  let sent = 0;
  let failed = 0;
  let configured = true;

  for (const s of due) {
    const { data: tokenRows } = await db.from('push_tokens').select('token').eq('user_id', s.owner_id);
    const tokens = (tokenRows ?? []).map((t) => t.token);
    const result = await sendPush(tokens, {
      title: 'おさらいしませんか？',
      body: `「${s.title}」が終わりました。記憶が新しいうちにおさらいしましょう。`,
      data: { screen: 'osarai' },
    });
    configured = result.configured;
    sent += result.sent;
    failed += result.failed;

    // 送信の成功(または配信対象自体が無い)を確認できた時だけ既読化する。
    // configured=false(FCM未設定)や failed>0(実送信エラー)の場合はreminded_atを
    // 更新しない＝次回cron実行でも再度対象になり、通知の取りこぼしを防ぐ
    // （Gemini独立レビュー指摘: 送信前クレームだと送信失敗時に通知が失われるため）。
    if (result.configured && result.failed === 0) {
      await db.from('schedules').update({ reminded_at: now.toISOString() }).eq('id', s.id).is('reminded_at', null);
    }
  }

  return NextResponse.json({ targeted: due.length, sent, failed, configured });
}
