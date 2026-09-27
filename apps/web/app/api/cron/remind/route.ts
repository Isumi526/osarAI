// 前日の準備の通知（毎日1回・Vercel Cron）。2026-09-27 に作り替え。
// 旧: 契約中の全員に一律「おさらいしませんか？」を送っていた（入力を促す通知）。
// 新: 会議録音が主導線になり、価値が「会う前に思い出す」「約束を守る」に移ったので、
//     明日会う人ごとに「前回の話」を、明日までが期限の TODO をまとめて知らせる。
//     何も無い人には送らない（毎日の一律通知はうるさいだけなので）。
// アプリ内通知（ベル）に必ず残し、プッシュ用トークンがあれば push も送る（lib/notify）。
// T10#4: cron/スケジューラは共有シークレットヘッダ必須。secret未設定時の素通しフォールバック禁止。
import { NextResponse } from 'next/server';
import { jstDateString, jstDayStartUtc, meetingRecapLine } from '@osarai/shared';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { activeUsers, notifyUser } from '@/lib/notify';

const JOB_NAME = 'osarai_remind';
/** 1人に出す「明日会う人」の上限（多すぎると読まれない） */
const MAX_PEOPLE = 3;

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
  // 実行はここで弾く（Gemini独立レビュー指摘・T5）。job+日付の一意制約で担保。
  const { error: dedupeError } = await db.from('cron_runs').insert({ job: JOB_NAME, run_date: jstDateString() });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ skipped: true, reason: 'already ran today' });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  const tomorrowStart = new Date(jstDayStartUtc().getTime() + 24 * 3600_000);
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 3600_000);

  let targeted = 0;
  let notified = 0;
  let pushSent = 0;
  let pushConfigured = false;

  for (const { userId, orgId } of await activeUsers(db)) {
    // 明日、相手が決まっている予定（＝会う人）
    const { data: schedules } = await db
      .from('schedules')
      .select('id, title, start_at, customer_id')
      .eq('owner_id', userId)
      .not('customer_id', 'is', null)
      .gte('start_at', tomorrowStart.toISOString())
      .lt('start_at', tomorrowEnd.toISOString())
      .order('start_at', { ascending: true })
      .limit(MAX_PEOPLE);

    // 明日までが期限の、自分の TODO（期限切れも含む）
    const { data: dueTodos } = await db
      .from('tasks')
      .select('id, title')
      .eq('owner_id', userId)
      .eq('status', 'open')
      .eq('assignee', 'self')
      .lt('due_at', tomorrowEnd.toISOString())
      .order('due_at', { ascending: true })
      .limit(20);

    if ((schedules ?? []).length === 0 && (dueTodos ?? []).length === 0) continue;
    targeted += 1;

    for (const s of schedules ?? []) {
      const customerId = s.customer_id!;
      const [{ data: c }, { data: ix }] = await Promise.all([
        db.from('customers').select('name').eq('id', customerId).maybeSingle(),
        db
          .from('interactions')
          .select('ai_summary')
          .eq('customer_id', customerId)
          .order('met_at', { ascending: false, nullsFirst: false })
          .limit(5),
      ]);
      const name = c?.name ?? '相手';
      let recap: string | null = null;
      for (const r of ix ?? []) {
        const sum = (r.ai_summary ?? {}) as { minutes?: string; points?: string[] };
        recap = meetingRecapLine(sum.minutes ?? null) ?? sum.points?.[0] ?? null;
        if (recap) break;
      }
      const hm = new Date(s.start_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
      const r = await notifyUser(db, {
        userId,
        orgId,
        title: `明日 ${hm} ${name}さんと会います`,
        body: recap ? `前回の話: ${recap}` : '前回の記録はまだありません。会う時に録音しておきましょう。',
        linkPath: `/customers/${customerId}`,
        customerId,
      });
      notified += 1;
      pushSent += r.pushSent;
      pushConfigured = pushConfigured || r.pushConfigured;
    }

    const todos = dueTodos ?? [];
    if (todos.length > 0) {
      const first = todos[0]!.title;
      const r = await notifyUser(db, {
        userId,
        orgId,
        title: `明日までのTODOが${todos.length}件あります`,
        body: todos.length === 1 ? `「${first}」` : `「${first}」ほか${todos.length - 1}件`,
        linkPath: '/tasks',
        taskId: todos.length === 1 ? todos[0]!.id : null,
      });
      notified += 1;
      pushSent += r.pushSent;
      pushConfigured = pushConfigured || r.pushConfigured;
    }
  }

  return NextResponse.json({ targeted, notified, pushSent, configured: pushConfigured });
}
