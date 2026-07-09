// おさらい対話クライアント（§8-1）。/api/osarai/turn を 1ターンずつ叩く。
import { apiPost } from './api.js';
import type { OsaraiExtracted } from '@osarai/shared';

export interface OsaraiTurnResponse {
  sessionId: string;
  customerId: string | null;
  next_question: string | null;
  done: boolean;
  extracted: OsaraiExtracted;
  interactionId: string | null;
}

export async function osaraiTurn(input: {
  message: string;
  sessionId?: string;
  customerId?: string | null;
  forceEnd?: boolean;
}): Promise<OsaraiTurnResponse> {
  return apiPost<OsaraiTurnResponse>('/api/osarai/turn', input);
}

// 録音音声を文字起こし（§8-1 音声入力）。Blob を base64 にして STT エンドポイントへ。
export async function transcribeAudio(blob: Blob): Promise<string> {
  const audioBase64 = await blobToBase64(blob);
  const mimeType = blob.type || 'audio/webm';
  const { text } = await apiPost<{ text: string }>('/api/osarai/stt', { audioBase64, mimeType });
  return text;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // data:...;base64,XXXX の XXXX 部分だけ取り出す
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
