// Stripe Webhook（§11）。checkout.session.completed / customer.subscription.*
// を受けて subscriptions を service_role で更新（RLSバイパス）。
// 署名検証のため raw body を使う。
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe, toIso, planForPriceId, priceIdFromSubscription } from '@/lib/stripe';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { notifyOperator } from '@/lib/notify-operator';

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) {
    return NextResponse.json({ error: 'missing signature/secret' }, { status: 400 });
  }

  const stripe = getStripe();
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    return NextResponse.json({ error: `invalid signature: ${String(err)}` }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // A2対策: Stripeはイベントを再送しうる（同一event.idの重複配信）。
  // event.idをユニーク制約で先に記録し、既に処理済み(insert失敗=一意制約違反)なら
  // 何もせず200を返す(冪等)。並行到達に対しても安全(insertの一意制約が最終防御)。
  const { error: dedupeError } = await db
    .from('stripe_webhook_events')
    .insert({ id: event.id, type: event.type });
  if (dedupeError) {
    if (dedupeError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    return NextResponse.json({ error: 'dedupe insert failed' }, { status: 500 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id ?? session.metadata?.user_id;
      const subId = typeof session.subscription === 'string' ? session.subscription : null;
      if (userId && subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        await db.from('subscriptions').upsert(
          {
            user_id: userId,
            stripe_customer_id:
              typeof session.customer === 'string' ? session.customer : null,
            stripe_subscription_id: subId,
            plan: session.metadata?.plan ?? null,
            status: sub.status,
            promo_code: session.metadata?.promo_code || null,
            trial_end: toIso(sub.trial_end),
            current_period_end: toIso(sub.current_period_end),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        );
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // A1対策: 従来はstatus/trial_end/current_period_endのみ同期しplanを更新していなかった。
      // プラン変更（アップグレード/ダウングレード）がDBへ反映されず、entitlementが旧プランの
      // ままゲートし続けるバグがあった。Stripeの正=price idからplanを都度同期する。
      //
      // A2対策(順序ガード): event.id の冪等化だけでは「同じstripe_subscription_idに対する
      // 複数イベントが順序逆転して届く」ケース(再送・配信遅延)は防げない。event.created
      // (発生時刻)が既に適用済みの状態より古ければ、新しい状態を古い内容で巻き戻さないよう
      // 適用をスキップする。
      const sub = event.data.object;
      const eventCreatedIso = toIso(event.created);
      const { data: current } = await db
        .from('subscriptions')
        .select('last_stripe_event_at')
        .eq('stripe_subscription_id', sub.id)
        .maybeSingle();
      if (current?.last_stripe_event_at && eventCreatedIso && current.last_stripe_event_at > eventCreatedIso) {
        break; // より新しいイベントが既に適用済み＝順序逆転を検知、古い内容での上書きをスキップ
      }
      const plan = planForPriceId(priceIdFromSubscription(sub));
      await db
        .from('subscriptions')
        .update({
          ...(plan ? { plan } : {}),
          status: sub.status,
          trial_end: toIso(sub.trial_end),
          current_period_end: toIso(sub.current_period_end),
          last_stripe_event_at: eventCreatedIso,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', sub.id);
      break;
    }
    case 'invoice.payment_failed': {
      // A3対策: 14日トライアル後などの自動課金失敗は放置すると誰にも気づかれない
      // （§監視必須パス＝請求）。運営者へ通知＋ユーザーが自分で再決済できる導線(/billing)を用意する。
      // DBの status 自体は Stripe が続けて送る customer.subscription.updated(status=past_due等)で同期される。
      const invoice = event.data.object;
      const subId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
      let userId: string | null = null;
      if (subId) {
        const { data } = await db
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_subscription_id', subId)
          .maybeSingle();
        userId = data?.user_id ?? null;
      }
      await notifyOperator({
        kind: '要対応',
        task: '自動課金 失敗（invoice.payment_failed）',
        detail: `user_id=${userId ?? '不明'} / customer=${
          typeof invoice.customer === 'string' ? invoice.customer : '不明'
        } / invoice=${invoice.id}。ユーザーは /billing から再決済できます。`,
      });
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
