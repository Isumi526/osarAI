// 「自分をおさらいする」対話クライアント。/api/self-osarai/turn を1ターンずつ叩く。
// ステートレス(履歴はクライアント保持・毎回送信)。
import { apiPost } from './api.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface SelfOsaraiTurnResponse {
  next_question: string | null;
  done: boolean;
  extracted: {
    notes?: string[];
    fields?: { job?: string; products?: string; age?: string; gender?: string; background?: string; goal?: string };
  };
  history: ChatMessage[];
}

export async function selfOsaraiTurn(
  input: {
    message: string;
    history: ChatMessage[];
    forceEnd?: boolean;
    /** タイマー残り秒数。時間がある間はAI側から対話を終了させない（早期終了防止） */
    remainingSec?: number | null;
  },
  signal?: AbortSignal,
): Promise<SelfOsaraiTurnResponse> {
  return apiPost<SelfOsaraiTurnResponse>('/api/self-osarai/turn', input, signal);
}
