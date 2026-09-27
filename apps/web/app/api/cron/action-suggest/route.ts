// 週1回の「返事待ち」通知（Vercel Cron・毎週月曜朝）。2026-09-27 に作り替え。
// 旧: 7日おさらいしていない顧客がいる人に「今週まだおさらいしていない顧客がいます」（CRM 的な入力の催促）。
// 新: 会議で相手が引き受けたこと（TODO の相手待ち・tasks.assignee='other'）のうち、
//     期限を過ぎたもの・期限なしで1週間たったものを知らせる。「あの件、返事が来ていない」に
//     気づいて催促できるようにするのが目的。該当が無い人には送らない。
// アプリ内通知（ベル）に必ず残し、プッシュ用トークンがあれば push も送る（lib/notify）。
// T10#4: cron/スケジューラは共有シークレットヘッダ必須。secret未設定時の素通しフォールバック禁止。
import { NextResponse } from 'next/server';
import { jstDateString } from '@osarai/shared';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { activeUsers, notifyUser } from '@/lib/notify';

const JOB_NAME = 'action_suggest';
/** 期限の無い相手待ちは、これだけ日が経ったら「返事待ち」とみなす */
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
  const { error: dedupeError } = await db.from('cron_runs').insert({ job: JOB_NAME, run_date: jstDateString() });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ skipped: true, reason: 'already ran today' });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_DAYS * 24 * 3600_000).toISOString();

  let targeted = 0;
  let pushSent = 0;
  let configured = false;

  for (const { userId, orgId } of await activeUsers(db)) {
    // 相手待ちのうち「期限を過ぎた」か「期限なしで1週間たった」もの
    const { data: waiting } = await db
      .from('tasks')
      .select('id, title, customer_id')
      .eq('owner_id', userId)
      .eq('status', 'open')
      .eq('assignee', 'other')
      .or(`due_at.lt.${now},and(due_at.is.null,created_at.lt.${staleBefore})`)
      .order('created_at', { ascending: true })
      .limit(20);
    const items = waiting ?? [];
    if (items.length === 0) continue;
    targeted += 1;

    const first = items[0]!;
    let who = '';
    if (first.customer_id) {
      const { data: c } = await db.from('customers').select('name').eq('id', first.customer_id).maybeSingle();
      if (c?.name) who = `（${c.name}さん）`;
    }
    const r = await notifyUser(db, {
      userId,
      orgId,
      title: `返事待ちが${items.length}件あります`,
      body: `「${first.title}」${who}${items.length > 1 ? `ほか${items.length - 1}件` : ''}。そろそろ確認してみませんか？`,
      linkPath: '/tasks',
      customerId: first.customer_id,
      taskId: items.length === 1 ? first.id : null,
    });
    pushSent += r.pushSent;
    configured = configured || r.pushConfigured;
  }

  return NextResponse.json({ configured, targeted, sent: pushSent });
}
