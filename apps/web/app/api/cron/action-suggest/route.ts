// 定期的な行動提案プッシュ通知（習慣化・自発的アクション促進）。
// 週次でVercel Cronから呼ばれ、直近7日おさらいしていない顧客がいるユーザーへ
// 「今週まだおさらいしていない顧客がいます」を個別に通知する。
// 既存 cron/remind（毎日・全員一律）とは別ジョブ・別スケジュール。
// T10#4: cron/スケジューラは共有シークレットヘッダ必須。secret未設定時の素通しフォールバック禁止。
import { NextResponse } from 'next/server';
import { jstDateString } from '@osarai/shared';
import { sendPush } from '@/lib/push-fcm';
import { createServiceRoleClient } from '@/lib/supabase/server';

const JOB_NAME = 'action_suggest';
const STALE_DAYS = 7;

export const runtime = 'nodejs';

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

  // Vercel Cronはat-least-once実行(まれに二重起動/リトライ)のため、同日2回目の
  // 実行はここで弾く（cron/remindと同じ job+日付一意制約パターン・T5対策踏襲）。
  const { error: dedupeError } = await db
    .from('cron_runs')
    .insert({ job: JOB_NAME, run_date: jstDateString() });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ skipped: true, reason: 'already ran today' });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  // 契約中(trialing/active)ユーザーのみ対象（RLSバイパス・システムジョブのため）
  const { data: activeSubs } = await db
    .from('subscriptions')
    .select('user_id')
    .in('status', ['trialing', 'active']);
  const activeUserIds = (activeSubs ?? []).map((s) => s.user_id);

  const staleBefore = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let targeted = 0;
  let sent = 0;
  let failed = 0;
  let configured = true;

  for (const userId of activeUserIds) {
    // 自分の担当顧客のうち、直近7日以内に接触していない(未接触含む)アクティブ顧客数
    const { count } = await db
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .eq('status', 'active')
      .or(`last_met_at.is.null,last_met_at.lt.${staleBefore}`);
    if (!count || count === 0) continue;

    const { data: tokenRows } = await db.from('push_tokens').select('token').eq('user_id', userId);
    const tokens = (tokenRows ?? []).map((t) => t.token);
    if (tokens.length === 0) continue;

    targeted += 1;
    const result = await sendPush(tokens, {
      title: '今週まだおさらいしていない顧客がいます',
      body: `${count}人の顧客が、しばらくおさらいできていません。5分で振り返ってみませんか？`,
      data: { screen: 'home' },
    });
    configured = result.configured;
    sent += result.sent;
    failed += result.failed;
  }

  return NextResponse.json({ configured, targeted, sent, failed });
}
