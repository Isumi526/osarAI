// Supabase クライアント（モバイル）。anon キーのみ使用。
// service_role / Gemini / Stripe 秘匿キーはクライアントに置かない（§15）。
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // フェーズ1では .env 未設定でも起動は通す。Auth導入（フェーズ3）で必須化。
  console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です');
}

export const supabase = createClient(url ?? '', anonKey ?? '');
