// 3層プラン定義（§11）。価格は定価（チャネル割引はStripe Coupon側で額引き）。
import type { PlanId } from './types';

export interface PlanDef {
  id: PlanId;
  name: string;
  /** 定価（月額・JPY・税込表記想定） */
  listPrice: number;
  /** AI相談の月間上限。null = 無制限 */
  aiAdviceLimit: number | null;
  /** 録音取り込み可否（F-03） */
  recordingImport: boolean;
  /** リーダー集約ビュー（F-05） */
  leaderDashboard: boolean;
}

export const PLANS: Record<PlanId, PlanDef> = {
  light: {
    id: 'light',
    name: 'Light',
    listPrice: 1980,
    aiAdviceLimit: 10,
    recordingImport: false,
    leaderDashboard: false,
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    listPrice: 3980,
    aiAdviceLimit: null,
    recordingImport: true,
    leaderDashboard: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    listPrice: 6980,
    aiAdviceLimit: null,
    recordingImport: true,
    leaderDashboard: true,
  },
};

/** 14日カード先取りトライアル（§11） */
export const TRIAL_PERIOD_DAYS = 14;

// ---- サブスク状態から機能アクセスを判定（§11 / §16 未契約は機能制限）----

/** 機能を使える契約状態（トライアル中も可） */
export const ACTIVE_SUB_STATUSES = ['trialing', 'active'] as const;

export function isSubscriptionActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SUB_STATUSES as readonly string[]).includes(status);
}

/** plan 文字列（DBは自由文字列）から PlanDef を引く。不明なら null。 */
export function planDef(plan: string | null | undefined): PlanDef | null {
  if (plan && plan in PLANS) return PLANS[plan as PlanId];
  return null;
}
