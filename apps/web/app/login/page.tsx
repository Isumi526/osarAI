'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase/browser';
import { Spinner } from '@/components/Spinner';
import { toJaAuthError } from '@/lib/auth-errors';
import { PasswordInput } from '@/components/PasswordInput';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // middlewareがLPの?ref=/?code=を保持するCookieを見て、新規登録リンクにも引き継ぐ
  // (サーバー側の初期描画とhydration不一致を避けるためmount後に反映)。
  const [signupHref, setSignupHref] = useState('/signup');
  useEffect(() => {
    const ref = document.cookie.match(/(?:^|; )osarai_ref=([^;]+)/)?.[1];
    const code = document.cookie.match(/(?:^|; )osarai_code=([^;]+)/)?.[1];
    const params = new URLSearchParams();
    if (ref) params.set('ref', ref);
    if (code) params.set('code', code);
    if (params.size > 0) setSignupHref(`/signup?${params.toString()}`);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createBrowserSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      setError(toJaAuthError(error.message));
      return;
    }
    // 未契約/解約ユーザーはWeb側のプラン選択へ誘導する(middlewareの本番待ちゲートと同じ基準)。
    // 契約中/トライアル中のみ、実際に使うモバイルアプリ側(app.osarai.app)へ、決済完了後と同じ
    // セッション引き継ぎ(URLフラグメント経由・サーバーに送られない)で自動ログイン状態にして遷移する。
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', data.user!.id)
      .maybeSingle<{ status: string | null }>();
    const isActive = sub?.status === 'trialing' || sub?.status === 'active';
    if (!isActive) {
      window.location.assign('/subscribe');
      return;
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.osarai.app';
    const session = data.session;
    const handoff = session
      ? `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token)}`
      : '';
    window.location.assign(`${appUrl}/${handoff}`);
  }

  return (
    <main style={{ maxWidth: 400, margin: '0 auto', padding: '64px 24px' }}>
      <h1>ログイン</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <PasswordInput value={password} onChange={setPassword} placeholder="パスワード" required />
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading} style={{ padding: 12, fontSize: 16 }}>
          {loading ? <Spinner /> : 'ログイン'}
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        アカウントがない方は <Link href={signupHref}>新規登録</Link>
      </p>
    </main>
  );
}
