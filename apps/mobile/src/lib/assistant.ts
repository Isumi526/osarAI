// 統合AIチャットのクライアント（2026-08-06 UI/UX刷新）。lib/osarai.ts と同型。
import { apiPost } from './api.js';

export interface SimilarNameCandidate {
  id: string;
  name: string;
  score: number;
}
export interface PersonProposal {
  customer_id: string | null;
  name: string;
  /** その人について今回わかったこと・話した内容・約束（自由記述1本・0035） */
  memo: string;
  /** カードのメモに足す、この人について新しく分かったこと（0036） */
  card_note?: string;
  /** 相手が「どんな人とつながりたいか」（Phase2 マッチングの入力） */
  wants_to_meet: string[];
  /** @deprecated 旧形式（0035 以前に保存された会議候補）。表示時は personMemo / personWantsToMeet で読み替える */
  points?: string[];
  /** @deprecated 旧形式 */
  needs?: string[];
  /** @deprecated 旧形式 */
  next_actions?: string[];
  /** @deprecated 旧形式 */
  custom_fields?: Record<string, unknown>;
  /** 同一人物かもしれない既存つながり（新規登録になる時だけサーバーが付ける）。 */
  similar?: SimilarNameCandidate[];
}
export interface ScheduleProposal {
  title: string;
  start_at: string;
  end_at: string;
  person_index: number | null;
  location?: string | null;
  mode?: string | null;
  category?: string | null;
}
export interface TaskProposal {
  title: string;
  due_at: string | null;
  person_index: number | null;
  /** self=自分がやる / other=相手がやる（相手待ち）。省略時 self */
  assignee?: 'self' | 'other';
}
export interface Proposals {
  people: PersonProposal[];
  schedules: ScheduleProposal[];
  tasks: TaskProposal[];
  self_notes: string[];
  self_fields?: Record<string, string>;
}

export interface AssistantTurnResponse {
  sessionId: string;
  reply: string | null;
  intent: 'record' | 'consult' | 'self' | 'unknown';
  customer_question: {
    question: string;
    candidates: { id: string; name: string }[];
    allow_new: boolean;
  } | null;
  proposals: Proposals | null;
  done: boolean;
}

export interface AssistantCommitResponse {
  customers: { id: string; name: string; isNew: boolean }[];
  interactionIds: string[];
  scheduleIds: string[];
  taskIds: string[];
}

export async function assistantTurn(
  input: {
    message: string;
    sessionId?: string;
    forceEnd?: boolean;
    confirmedCustomerId?: string | null;
    /** 相手のカード等から開いた時の話題の相手（その人の議事録を読んで相談に答える） */
    focusCustomerId?: string | null;
  },
  signal?: AbortSignal,
): Promise<AssistantTurnResponse> {
  return apiPost<AssistantTurnResponse>('/api/assistant/turn', input, signal);
}

export async function assistantCommit(input: {
  sessionId: string;
  proposals: Proposals;
}): Promise<AssistantCommitResponse> {
  return apiPost<AssistantCommitResponse>('/api/assistant/commit', input);
}
