import { type NextRequest } from 'next/server';
import { updateSession } from './lib/supabase/middleware';

const REF_COOKIE = 'osarai_ref';

export async function middleware(request: NextRequest) {
  const response = await updateSession(request);
  // LPの?ref=CODEをCookieに保持し、ヘッダーの新規登録リンク等サイト内どこから
  // signupへ向かってもチャネル紹介コードが引き継がれるようにする。
  const ref = request.nextUrl.searchParams.get('ref');
  if (ref) {
    response.cookies.set(REF_COOKIE, ref, { path: '/', maxAge: 60 * 60 * 24 * 30 });
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
