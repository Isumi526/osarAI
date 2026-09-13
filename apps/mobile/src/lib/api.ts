// Web API（Next.js Route Handlers）呼び出しヘルパー（§3/§4）。
// モバイルは別オリジンのため、Supabase の access_token を Bearer で渡して認証する。
// AI処理(Gemini)はサーバー側にあり、クライアントから直接は叩かない（§15）。
import { supabase } from './supabase.js';

// 開発時は Web の dev サーバー。Capacitor 実機ビルドでは本番 URL を .env で差し込む。
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
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
    signal,
  });

  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    // サーバーが日本語の message を付けていればそれをユーザーに見せる（'plan_upgrade_required' 等の
    // 識別子をそのまま出さない）。code は呼び出し側の分岐用に保持する。
    const j = json as { error?: string; message?: string };
    const err = new ApiError(j.message ?? j.error ?? `API ${res.status}`, res.status, j.error ?? null);
    throw err;
  }
  return json as T;
}
