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
  points: string[];
  needs: string[];
  next_actions: string[];
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
  input: { message: string; sessionId?: string; forceEnd?: boolean; confirmedCustomerId?: string | null },
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
