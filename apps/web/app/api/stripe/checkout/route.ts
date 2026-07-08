// Checkout セッション作成（§11）。14日トライアル先取り・Apple Pay/Google Payは
// Stripeダッシュボードで該当決済手段を有効化すれば Checkout に自動表示される。
import { NextResponse } from 'next/server';
import { TRIAL_PERIOD_DAYS, type PlanId } from '@osarai/shared';
import { createServerSupabase } from '@/lib/supabase/server';
import { getStripe, priceIdForPlan } from '@/lib/stripe';

export async function POST(req: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const stripe = getStripe();
  const body = (await req.json()) as { plan?: PlanId; promoCode?: string };
  const plan = body.plan ?? 'standard';
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return NextResponse.json({ error: 'price not configured' }, { status: 500 });
  }

  // チャネル割引コード（任意）。コード文字列 → Promotion Code ID を解決して適用。
  // A4対策: コードは特定プラン向けに発行される（Coupon.metadata.plan が正）。
  // 選択プランと不一致なら Coupon の applies_to 設定に依存せずここで拒否する
  // （例: Standard用¥1000offコードをLightに適用して過剰割引＝恒久的な請求漏れを防ぐ）。
  let discounts: { promotion_code: string }[] | undefined;
  let appliedCode: string | undefined;
  if (body.promoCode) {
    const found = await stripe.promotionCodes.list({
      code: body.promoCode,
      active: true,
      limit: 1,
    });
    const pc = found.data[0];
    if (pc) {
      const codePlan = pc.coupon.metadata?.plan;
      if (codePlan !== plan) {
        return NextResponse.json(
          { error: 'このコードは選択したプランには使用できません。プランをご確認ください。' },
          { status: 400 },
        );
      }
      discounts = [{ promotion_code: pc.id }];
      appliedCode = pc.code;
    }
  }

  const origin = req.headers.get('origin') ?? 'http://localhost:3000';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    subscription_data: { trial_period_days: TRIAL_PERIOD_DAYS },
    metadata: { user_id: user.id, plan, promo_code: appliedCode ?? '' },
    // コードが解決できた時はそれを適用、無ければ手入力欄を出す
    ...(discounts ? { discounts } : { allow_promotion_codes: true }),
    success_url: `${origin}/dashboard?welcome=1`,
    cancel_url: `${origin}/subscribe`,
  });

  return NextResponse.json({ url: session.url });
}
