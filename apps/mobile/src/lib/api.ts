// Web API（Next.js Route Handlers）呼び出しヘルパー（§3/§4）。
// モバイルは別オリジンのため、Supabase の access_token を Bearer で渡して認証する。
// AI処理(Gemini)はサーバー側にあり、クライアントから直接は叩かない（§15）。
import { supabase } from './supabase.js';

// 開発時は Web の dev サーバー。Capacitor 実機ビルドでは本番 URL を .env で差し込む。
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? `API ${res.status}`);
  }
  return json as T;
}
