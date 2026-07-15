// 顧客の温度感(hot/warm/cold)を、登録情報(直近接触日)とアポ履歴(直近の予定件数)から
// 自動算出する（手動設定UIを廃止し、この関数の結果で置き換える。議事録『review』回答A：
// 簡易スコアリング・コスト最小・説明可能な方式を採用）。
import type { Temperature } from './types.js';

export interface AutoTemperatureInput {
  /** 直近の接触日（customers.last_met_at）。おさらい完了時に更新される。 */
  lastMetAt: string | null;
  /** 直近60日以内の予定件数（私用を除く）。 */
  recentMeetingCount: number;
}

const HOT_WITHIN_DAYS = 14;
const WARM_WITHIN_DAYS = 60;
const HOT_MIN_RECENT_MEETINGS = 2;

export function computeAutoTemperature(input: AutoTemperatureInput): Temperature {
  if (!input.lastMetAt) return 'cold';
  const daysSinceLastMet = (Date.now() - new Date(input.lastMetAt).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceLastMet <= HOT_WITHIN_DAYS && input.recentMeetingCount >= HOT_MIN_RECENT_MEETINGS) return 'hot';
  if (daysSinceLastMet <= WARM_WITHIN_DAYS) return 'warm';
  return 'cold';
}
