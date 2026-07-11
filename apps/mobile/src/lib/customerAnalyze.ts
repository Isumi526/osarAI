// 顧客登録AI解析（紹介文テキスト or 自己紹介シート画像 → 顧客カード初期値抽出）。
import { apiPost } from './api.js';
import type { Temperature } from '@osarai/shared';

export interface AnalyzedCustomer {
  name: string | null;
  needs: string | null;
  temperature: Temperature | null;
}

export async function analyzeCustomerText(text: string): Promise<AnalyzedCustomer> {
  const { extracted } = await apiPost<{ extracted: AnalyzedCustomer }>('/api/customers/analyze', { text });
  return extracted;
}

export async function analyzeCustomerImage(file: File): Promise<AnalyzedCustomer> {
  const imageBase64 = await fileToBase64(file);
  const { extracted } = await apiPost<{ extracted: AnalyzedCustomer }>('/api/customers/analyze', {
    imageBase64,
    mimeType: file.type || 'image/jpeg',
  });
  return extracted;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
