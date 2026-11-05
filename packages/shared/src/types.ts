// ドメイン共通型（§6 データモデルに対応する手書きの軽量型）
// 注意：これは UI/ロジック用の薄い型。DBの正本型は database.types.ts（自動生成）を使う。

export type Role = 'member' | 'leader' | 'agency';

export type CustomerStatus = 'active' | 'archived';
export type Temperature = 'hot' | 'warm' | 'cold';

export type InteractionSource = 'ai_dialogue' | 'in_person_rec' | 'zoom_rec' | 'manual';
export type InteractionType = 'audio' | 'text';

export type OsaraiSessionStatus = 'in_progress' | 'done';

export type ChatScope = 'all' | 'customer';
export type ChatRole = 'user' | 'assistant';

export type PlanId = 'light' | 'standard' | 'pro' | 'leader' | 'member';
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

// おさらい対話で AI が抽出する顧客カード項目（§8-1）。
// 2026-11-03 から要点/ニーズ/次アクション/custom_fields に分けず、自由記述のメモ1本（memo）＋
// つながりたい人（wants_to_meet）で受け取る（migration 0035）。旧キーは途中のセッションの読み取り用に残す。
export interface OsaraiExtracted {
  /** 相手について今回わかったこと・話した内容・約束を、読みやすい文章で1本にまとめたメモ */
  memo?: string;
  /** カードのメモに足す、この人について新しく分かったこと（memo と同じ文は書かない・0036） */
  card_note?: string;
  /** 相手が「どんな人とつながりたいか」（Phase2 マッチングの入力・構造のまま残す） */
  wants_to_meet?: string[];
  temperature?: Temperature | null;
  /** @deprecated 旧形式（0035 以前のセッション）。新規の抽出では使わない */
  points?: string[];
  /** @deprecated 旧形式 */
  needs?: string[];
  /** @deprecated 旧形式 */
  next_actions?: string[];
  /** @deprecated 旧形式 */
  custom_fields?: Record<string, unknown>;
  /** 対話中に判明した相手の名前（未言及なら null）。§F-02: 新規/仮名のカードへの自動反映に使う */
  name?: string | null;
  /**
   * 対話中にユーザー自身について言及があった場合の構造化情報（相手ではなく本人について）。
   * 言及が無かった項目はキー自体を含めない（議事録『review』回答A）。
   * self-osarai(自分をおさらい)のfields抽出と同じ形。merge_user_profile_fields RPCで
   * profiles.user_profileへ反映する。
   */
  self_fields?: { age?: string; gender?: string; job?: string; products?: string; background?: string; goal?: string };
}

// /api/osarai/turn の応答契約（§8-1）
export interface OsaraiTurnResult {
  extracted: OsaraiExtracted;
  next_question: string | null;
  done: boolean;
  /**
   * done=true の理由。'user_request'=ユーザーが明示的に終了を望んだ／'time_up'=残り時間切れ／
   * 'enough'=AIが十分と判断。残り時間があるのに end_reason!=='user_request' で done になった場合、
   * サーバー側で done を取り消して対話を継続させる（AIによる早期終了防止）。
   */
  end_reason?: 'user_request' | 'time_up' | 'enough' | null;
}

// interactions.ai_summary の形（§6）。
// 2026-11-03 から、その回の要約は interactions.summary（自由記述）に書く（migration 0035）。
// ai_summary には議事録（minutes）だけを書き、points/needs/next_actions は旧データの読み取り用に残す。
export interface AiSummary {
  /** @deprecated 旧形式。新規には書かない（interactions.summary を使う） */
  points?: string[];
  /** @deprecated 旧形式 */
  needs?: string[];
  /** @deprecated 旧形式 */
  next_actions?: string[];
  /** 会議録音由来の議事録（T3）。主たる相手の履歴にだけ付く。 */
  minutes?: string;
}
