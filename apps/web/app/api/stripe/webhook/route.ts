import { NextResponse } from 'next/server';

// Stripe Webhook（customer.subscription.* / checkout.session.completed）。
// service_role で subscriptions を更新（§11）。— 実装はフェーズ4。
export function POST() {
  return NextResponse.json({ todo: 'phase4: stripe webhook' }, { status: 501 });
}
