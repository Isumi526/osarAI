// サーバー用 Supabase クライアント。
// - createServerSupabase: cookieからセッションを読む通常クライアント（RLS有効・anon）。
// - createServiceRoleClient: RLSをバイパスする特権クライアント。サーバー内・最小限のみ
//   （例：Stripe Webhook で subscriptions 更新。§7注記/§11）。クライアントへ絶対出さない。
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '@osarai/shared/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient<Database>(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component から呼ばれた場合は set 不可。middleware がセッション更新を担う。
        }
      },
    },
  });
}

export function createServiceRoleClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
