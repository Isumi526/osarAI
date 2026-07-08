// Stripe Billing Portal セッション作成（A3対策のユーザー再決済導線）。
// past_due（自動課金失敗）等で本人がカード情報を更新・再決済できるようにする。
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

export async function POST(req: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle<{ stripe_customer_id: string | null }>();
  if (!sub?.stripe_customer_id) {
    return NextResponse.json({ error: 'no_subscription' }, { status: 400 });
  }

  const stripe = getStripe();
  const origin = req.headers.get('origin') ?? 'http://localhost:3000';
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
