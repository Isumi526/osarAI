import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from './lib/supabase/middleware';

const REF_COOKIE = 'osarai_ref';
const ACTIVE_STATUSES = new Set(['trialing', 'active']);
// 未契約/解約ユーザーでも触れる必要がある画面(課金導線そのもの・認証・公開ページ)。
const PLAN_GATE_EXEMPT = ['/subscribe', '/billing', '/login', '/signup', '/terms', '/api'];

export async function middleware(request: NextRequest) {
  const response = await updateSession(request);
  // LPの?ref=CODEをCookieに保持し、ヘッダーの新規登録リンク等サイト内どこから
  // signupへ向かってもチャネル紹介コードが引き継がれるようにする。
  const ref = request.nextUrl.searchParams.get('ref');
  if (ref) {
    response.cookies.set(REF_COOKIE, ref, { path: '/', maxAge: 60 * 60 * 24 * 30 });
  }

  const { pathname } = request.nextUrl;
  const exempt = pathname === '/' || PLAN_GATE_EXEMPT.some((p) => pathname.startsWith(p));
  if (!exempt) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      { cookies: { getAll: () => request.cookies.getAll(), setAll: () => {} } },
    );
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user.id)
        .maybeSingle<{ status: string | null }>();
      if (!sub || !ACTIVE_STATUSES.has(sub.status ?? '')) {
        return NextResponse.redirect(new URL('/subscribe', request.url));
      }
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
