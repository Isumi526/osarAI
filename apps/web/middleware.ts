import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from './lib/supabase/middleware';

const REF_COOKIE = 'osarai_ref';
const CODE_COOKIE = 'osarai_code';
const ACTIVE_STATUSES = new Set(['trialing', 'active']);
// past_due(自動課金失敗・支払い方法更新待ち)は「未契約」と区別する。実際の機能制限は
// モバイルアプリ側のentitlement(isSubscriptionActive・変更なし)が別途担うため、この
// Web側ゲートではpast_dueを/subscribeへ弾かず/dashboard・/billing等へ通す
// (「プランを選んでください」ではなく/billingの再決済導線へ自然に辿り着けるようにする)。
const BILLING_ISSUE_STATUSES = new Set(['past_due']);
// 未契約/解約ユーザーでも触れる必要がある画面(課金導線そのもの・認証・公開ページ)。
const PLAN_GATE_EXEMPT = ['/subscribe', '/billing', '/login', '/signup', '/terms', '/api'];

export async function middleware(request: NextRequest) {
  const response = await updateSession(request);
  // LPの?ref=CODE(紹介コード)・?code=CODE(チャネル割引コード)をCookieに保持し、
  // ヘッダーの新規登録リンク等サイト内どこからsignupへ向かっても引き継がれるようにする。
  const ref = request.nextUrl.searchParams.get('ref');
  if (ref) {
    response.cookies.set(REF_COOKIE, ref, { path: '/', maxAge: 60 * 60 * 24 * 30 });
  }
  const code = request.nextUrl.searchParams.get('code');
  if (code) {
    response.cookies.set(CODE_COOKIE, code, { path: '/', maxAge: 60 * 60 * 24 * 30 });
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
      // agency(LL代理店本体)はprofiles/subscriptionsを持つ「ユーザー」ではなく契約もしない
      // アクターのため、課金ゲートの対象外にする（【要設計判断】代理店/リーダー再設計・回答A）。
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle<{ role: string | null }>();
      if (profile?.role !== 'agency') {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('status')
          .eq('user_id', user.id)
          .maybeSingle<{ status: string | null }>();
        const status = sub?.status ?? '';
        if (!sub || (!ACTIVE_STATUSES.has(status) && !BILLING_ISSUE_STATUSES.has(status))) {
          return NextResponse.redirect(new URL('/subscribe', request.url));
        }
      }
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
