// AI戦略相談クライアント（§8-3）。/api/advice を叩く。
import { apiPost } from './api.js';
import type { ChatScope } from '@osarai/shared';

export interface AdviceResponse {
  chatId: string;
  reply: string;
}

export async function askAdvice(input: {
  message: string;
  scope: ChatScope;
  customerId?: string | null;
  chatId?: string;
}): Promise<AdviceResponse> {
  return apiPost<AdviceResponse>('/api/advice', input);
}
