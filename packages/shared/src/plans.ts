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
    // 会議録音(メイン機能)は有料プラン全部で開放する（D1・2026-09-13 人確認）。
    // 上位プランとの差は将来「月N本」の回数fenceで切る。member(招待制・無料)は据え置き。
    recordingImport: true,
    leaderDashboard: false,
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    listPrice: 1980,
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
  // 【要設計判断】代理店(LL)とリーダー課金プランの再設計（回答A）で新設。
  // 招待元(リーダー)の自己申込チェックアウト導線は本チケットのスコープ外
  // (価格未確定・運営者の業務判断が必要)。listPrice=0はプレースホルダーであり、
  // 実際の価格が決まりStripe Priceを作成するまで自己申込フローには使わない
  // (当面はprofiles.role='leader'同様、運営者がDBを手動更新して付与する運用)。
  leader: {
    id: 'leader',
    name: 'Leader（価格未確定・要業務判断）',
    listPrice: 0,
    aiAdviceLimit: null,
    recordingImport: true,
    leaderDashboard: false,
  },
  // リーダーに招待された相手が使う無料プラン。招待元リーダーの商品リストのみ
  // インポート可能(org全体スコープではない・agency_products_selectのRLS参照)。
  member: {
    id: 'member',
    name: 'Member（招待制・無料）',
    listPrice: 0,
    aiAdviceLimit: 10,
    recordingImport: false,
    leaderDashboard: false,
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
