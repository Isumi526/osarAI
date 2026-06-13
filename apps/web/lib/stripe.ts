// Stripe サーバーSDK（秘匿キーはサーバーのみ・§15）。
// 遅延生成：ビルド時(page data収集)に env 未設定で構築例外にならないよう、
// 実際のリクエスト処理で getStripe() を呼んで初めてインスタンス化する。
import Stripe from 'stripe';
import type { PlanId } from '@osarai/shared';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(key);
  }
  return _stripe;
}

// プラン → Price ID（.env。フェーズ0 B-1 で作成済み）
export function priceIdForPlan(plan: PlanId): string {
  switch (plan) {
    case 'light':
      return process.env.STRIPE_PRICE_LIGHT ?? '';
    case 'standard':
      return process.env.STRIPE_PRICE_STANDARD ?? '';
    case 'pro':
      return process.env.STRIPE_PRICE_PRO ?? '';
  }
}

/** UNIX秒 → ISO文字列（null安全）。 */
export function toIso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}
