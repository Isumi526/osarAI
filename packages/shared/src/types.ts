// ドメイン共通型（§6 データモデルに対応する手書きの軽量型）
// 注意：これは UI/ロジック用の薄い型。DBの正本型は database.types.ts（自動生成）を使う。

export type Role = 'member' | 'leader';

export type CustomerStatus = 'active' | 'archived';
export type Temperature = 'hot' | 'warm' | 'cold';

export type InteractionSource = 'ai_dialogue' | 'in_person_rec' | 'zoom_rec' | 'manual';
export type InteractionType = 'audio' | 'text';

export type OsaraiSessionStatus = 'in_progress' | 'done';

export type ChatScope = 'all' | 'customer';
export type ChatRole = 'user' | 'assistant';

export type PlanId = 'light' | 'standard' | 'pro';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

// おさらい対話で AI が抽出する顧客カード項目（§8-1）
export interface OsaraiExtracted {
  points?: string[];
  needs?: string[];
  temperature?: Temperature | null;
  next_actions?: string[];
  custom_fields?: Record<string, unknown>;
}

// /api/osarai/turn の応答契約（§8-1）
export interface OsaraiTurnResult {
  extracted: OsaraiExtracted;
  next_question: string | null;
  done: boolean;
}

// interactions.ai_summary の形（§6）
export interface AiSummary {
  points: string[];
  needs: string[];
  next_actions: string[];
}
