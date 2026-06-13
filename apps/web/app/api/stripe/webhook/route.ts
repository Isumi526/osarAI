// Stripe Webhook（§11）。checkout.session.completed / customer.subscription.*
// を受けて subscriptions を service_role で更新（RLSバイパス）。
// 署名検証のため raw body を使う。
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe, toIso } from '@/lib/stripe';
import { createServiceRoleClient } from '@/lib/supabase/server';

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
      const sub = event.data.object;
      await db
        .from('subscriptions')
        .update({
          status: sub.status,
          trial_end: toIso(sub.trial_end),
          current_period_end: toIso(sub.current_period_end),
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', sub.id);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
