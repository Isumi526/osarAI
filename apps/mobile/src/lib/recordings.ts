// 録音取り込みクライアント（§8-2 / F-03・サブ経路）。
// 音声ファイル/Blob を base64 にして /api/transcribe へ。サーバーがStorage保存+文字起こし+
// 要約+interaction作成まで行う。録れた時だけの任意導線。
import { apiPost } from './api.js';
import type { AiSummary, InteractionSource } from '@osarai/shared';

export interface TranscribeResponse {
  interactionId: string;
  transcript: string;
  summary: AiSummary;
}

export async function importRecording(input: {
  customerId: string;
  file: Blob;
  source: InteractionSource;
}): Promise<TranscribeResponse> {
  const audioBase64 = await fileToBase64(input.file);
  const mimeType = input.file.type || 'audio/webm';
  return apiPost<TranscribeResponse>('/api/transcribe', {
    customerId: input.customerId,
    source: input.source,
    audioBase64,
    mimeType,
  });
}

function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
