// 3層プラン定義（§11）。価格は定価（チャネル割引はStripe Coupon側で額引き）。
import type { PlanId } from './types.js';

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
