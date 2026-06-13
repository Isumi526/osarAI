// サーバー専用 Supabase クライアント。
// - 通常操作は anon キー（RLS有効）。
// - Stripe Webhook 等で RLS をバイパスする時のみ service_role を使う（§7注記・§11）。
//   service_role は絶対にクライアントへ出さない。
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

/** RLSを尊重する通常のサーバークライアント（anon）。 */
export function createAnonServerClient() {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  return createClient(url, anonKey);
}

/** RLSをバイパスする特権クライアント。サーバー内・最小限の用途のみ（例：Stripe Webhook）。 */
export function createServiceRoleClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
