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
  // middlewareがLPの?ref=CODEを保持するCookieを見て、新規登録リンクにも引き継ぐ
  // (サーバー側の初期描画とhydration不一致を避けるためmount後に反映)。
  const [signupHref, setSignupHref] = useState('/signup');
  useEffect(() => {
    const ref = document.cookie.match(/(?:^|; )osarai_ref=([^;]+)/)?.[1];
    if (ref) setSignupHref(`/signup?ref=${ref}`);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      setError(toJaAuthError(error.message));
      return;
    }
    // ハードナビゲーションで遷移する。router.push だと初回はサーバー側が
    // まだ新しい認証クッキーを認識できず /login に戻され「1回目は無反応・
    // 2回目で成功」に見えることがあるため（@supabase/ssr のクッキー伝播レース）。
    // loading は解除せず、ページ遷移までスピナーを出したままにする。
    window.location.assign('/dashboard');
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
