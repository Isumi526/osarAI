// モバイル(別オリジンのVite/Capacitor)から Web API を叩くための認証＋CORS（§3/§4）。
// - Web画面からは Cookie セッション、モバイルからは Authorization: Bearer <access_token>。
// - どちらも anon キー + ユーザートークンで RLS スコープ済みクライアントを返す＝
//   service_role は使わない（テナント/owner 分離は RLS に委ねる・§7）。
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import type { Database } from '@osarai/shared/database.types';
import { createServerSupabase } from '@/lib/supabase/server';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';

export interface AuthedContext {
  supabase: SupabaseClient<Database>;
  user: User;
}

/**
 * リクエストを認証し、そのユーザーとして RLS が効く Supabase クライアントを返す。
 * Bearer トークン優先（モバイル）、無ければ Cookie セッション（Web）。
 * 失敗時は null。
 */
export async function authedFromRequest(req: Request): Promise<AuthedContext | null> {
  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

  if (bearer) {
    const supabase = createClient<Database>(url, anon, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const {
      data: { user },
    } = await supabase.auth.getUser(bearer);
    if (!user) return null;
    return { supabase, user };
  }

  // Cookie セッション（Web 同一オリジン）
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { supabase: supabase as unknown as SupabaseClient<Database>, user };
}

// ---- CORS（Capacitor の capacitor://localhost 等、別オリジン対策）----
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
