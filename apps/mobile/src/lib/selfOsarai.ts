// 「自分をおさらいする」対話クライアント。/api/self-osarai/turn を1ターンずつ叩く。
// ステートレス(履歴はクライアント保持・毎回送信)。
import { apiPost } from './api.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface SelfOsaraiTurnResponse {
  next_question: string | null;
  done: boolean;
  extracted: { notes?: string[] };
  history: ChatMessage[];
}

export async function selfOsaraiTurn(input: {
  message: string;
  history: ChatMessage[];
  forceEnd?: boolean;
}): Promise<SelfOsaraiTurnResponse> {
  return apiPost<SelfOsaraiTurnResponse>('/api/self-osarai/turn', input);
}
