// ログアウト（Webナビの「ログアウト」から呼ぶ）。セッションcookieを失効させ /login へ戻す。
import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.url));
}
