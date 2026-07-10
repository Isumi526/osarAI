// アポ当日の事前戦略提案通知（§14後追加・「スケジュール参照でアポ当日に顧客戦略を事前通知」）。
// スケジュール管理機能に依存。Vercel Cronから毎朝1回呼ばれる想定。
// 当日(JST)に顧客が紐づくアポがあるユーザーへ、Geminiが生成した戦略提案をpushする。
// 他のcron(remind/action-suggest)と同じ job+日付の一意制約でdedup(1日1回)。
import { NextResponse } from 'next/server';
import { jstDateString, jstDayStartUtc } from '@osarai/shared';
import { sendPush } from '@/lib/push-fcm';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { buildContext } from '@/lib/customer-context';
import { geminiText, GEMINI_MODEL_LITE } from '@/lib/gemini';

const JOB_NAME = 'apo_strategy';

export const runtime = 'nodejs';
export const maxDuration = 60;

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

  // 同日2回目の実行を弾く（cron/remind・cron/action-suggestと同じdedupパターン）。
  const { error: dedupeError } = await db
    .from('cron_runs')
    .insert({ job: JOB_NAME, run_date: jstDateString() });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ skipped: true, reason: 'already ran today' });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  const todayStart = jstDayStartUtc();
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  // 当日(JST)に開始する、顧客が紐づいたアポのみ対象（顧客が無いと戦略提案の材料が無いため）。
  const { data: appointments, error: apError } = await db
    .from('schedules')
    .select('id, owner_id, customer_id, title, start_at')
    .not('customer_id', 'is', null)
    .gte('start_at', todayStart.toISOString())
    .lt('start_at', tomorrowStart.toISOString());
  if (apError) {
    return NextResponse.json({ error: 'query failed' }, { status: 500 });
  }
  if (!appointments || appointments.length === 0) {
    return NextResponse.json({ targeted: 0, sent: 0, failed: 0 });
  }

  let sent = 0;
  let failed = 0;
  let configured = true;

  for (const ap of appointments) {
    if (!ap.customer_id) continue;

    // service_roleはRLSをバイパスするため、顧客がこのスケジュールの所有者に
    // 属することを明示的に検証してから参照する（Gemini独立レビュー指摘・
    // テナント分離の防御的徹底。通常はUI側で自分の顧客しか選べないが、
    // データ不整合が起きた場合に他ユーザーの顧客情報を参照しないためのガード）。
    const { data: customerRow } = await db
      .from('customers')
      .select('owner_id')
      .eq('id', ap.customer_id)
      .maybeSingle();
    if (!customerRow || customerRow.owner_id !== ap.owner_id) {
      console.error('apo-strategy: schedule/customer owner mismatch, skipping', {
        scheduleId: ap.id,
        scheduleOwnerId: ap.owner_id,
        customerId: ap.customer_id,
      });
      continue;
    }

    const context = await buildContext(db, 'customer', ap.customer_id);
    let advice: string;
    try {
      advice = await geminiText(
        `次のアポを控えた営業担当者向けに、顧客データを踏まえた事前の戦略提案を3行以内・具体的に。\n\n${context}`,
        { model: GEMINI_MODEL_LITE, temperature: 0.5 },
      );
    } catch (e) {
      console.error('apo-strategy: gemini call failed, skipping this appointment', ap.id, e);
      continue; // このアポだけスキップ（他のアポ処理は継続）
    }

    const { data: tokenRows } = await db.from('push_tokens').select('token').eq('user_id', ap.owner_id);
    const tokens = (tokenRows ?? []).map((t) => t.token);
    const result = await sendPush(tokens, {
      title: `本日のアポ「${ap.title}」の事前戦略`,
      body: advice.slice(0, 180),
      data: { screen: 'schedule' },
    });
    configured = result.configured;
    sent += result.sent;
    failed += result.failed;
  }

  return NextResponse.json({ targeted: appointments.length, sent, failed, configured });
}
