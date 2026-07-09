// おさらい促し通知の自動配信（§12・DoD項目8の恒久対応）。
// Vercel Cron から1日1回呼ばれ、契約中(trialing/active)の全ユーザーへ「おさらいしませんか？」を送る。
// T10#4: cron/スケジューラは共有シークレットヘッダ必須。secret未設定時の素通しフォールバック禁止。
import { NextResponse } from 'next/server';
import { jstDateString } from '@osarai/shared';
import { sendPush } from '@/lib/push-fcm';
import { createServiceRoleClient } from '@/lib/supabase/server';

const JOB_NAME = 'osarai_remind';

export const runtime = 'nodejs';

const TITLE = 'おさらいしませんか？';
const BODY = '今日会った人、記憶が新しいうちに5分でおさらいしましょう。';

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
  // 実行はここで弾く（Gemini独立レビュー指摘・T5）。job+日付の一意制約で担保。
  const { error: dedupeError } = await db
    .from('cron_runs')
    .insert({ job: JOB_NAME, run_date: jstDateString() });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ skipped: true, reason: 'already ran today' });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  // 契約中(trialing/active)ユーザーのpush_tokenを取得（RLSバイパス・システムジョブのため）
  const { data: activeSubs } = await db
    .from('subscriptions')
    .select('user_id')
    .in('status', ['trialing', 'active']);
  const activeUserIds = (activeSubs ?? []).map((s) => s.user_id);
  if (activeUserIds.length === 0) {
    return NextResponse.json({ targeted: 0, sent: 0, failed: 0, configured: true });
  }

  const { data: tokenRows } = await db
    .from('push_tokens')
    .select('token')
    .in('user_id', activeUserIds);
  const tokens = (tokenRows ?? []).map((t) => t.token);

  const result = await sendPush(tokens, { title: TITLE, body: BODY, data: { screen: 'osarai' } });

  return NextResponse.json({ targeted: tokens.length, ...result });
}
