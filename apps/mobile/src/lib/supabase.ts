// Supabase クライアント（モバイル）。anon キーのみ使用。
// service_role / Gemini / Stripe 秘匿キーはクライアントに置かない（§15）。
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@osarai/shared/database.types';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です');
}

export const supabase = createClient<Database>(url ?? '', anonKey ?? '');
