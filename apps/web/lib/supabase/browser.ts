'use client';

// ブラウザ用 Supabase クライアント（anon・cookieベースのセッション）。
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@osarai/shared/database.types';

export function createBrowserSupabase() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  );
}
