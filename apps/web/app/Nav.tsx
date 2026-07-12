// 全ページ共通のシンプルなナビ。未ログイン: login/signup、ログイン中: dashboard/billing/logout。
import Link from 'next/link';
import { cookies } from 'next/headers';
import { createServerSupabase } from '@/lib/supabase/server';

export async function Nav() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // middlewareがLPの?ref=/?code=をCookieに保持しているため、ヘッダーの新規登録リンクからでも
  // 紹介コード・チャネル割引コードが引き継がれる。
  const cookieStore = await cookies();
  const ref = cookieStore.get('osarai_ref')?.value;
  const code = cookieStore.get('osarai_code')?.value;
  const signupParams = new URLSearchParams();
  if (ref) signupParams.set('ref', ref);
  if (code) signupParams.set('code', code);
  const signupHref = signupParams.size > 0 ? `/signup?${signupParams.toString()}` : '/signup';

  return (
    <nav
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 24px',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      <Link href="/" style={{ fontWeight: 700, color: 'var(--color-text)' }}>
        osarAI
      </Link>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 14 }}>
        {user ? (
          <>
            <Link href="/dashboard">ダッシュボード</Link>
            <Link href="/billing">お支払い</Link>
            <form action="/api/auth/logout" method="post">
              <button type="submit" style={{ background: 'none', color: 'var(--color-text-muted)', border: 'none', padding: 0, fontSize: 14 }}>
                ログアウト
              </button>
            </form>
          </>
        ) : (
          <>
            <Link href="/login">ログイン</Link>
            <Link href={signupHref}>新規登録</Link>
          </>
        )}
      </div>
    </nav>
  );
}
