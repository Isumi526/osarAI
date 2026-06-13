'use client';

// 新規登録（メール＋パスワード）。サインアップで auth.users 作成 → DBトリガーが
// profiles を LL組織・member で自動生成（migration 0003）。
// ※フェーズ4でこの後段に Stripe Checkout（14日トライアル）を挿入する。
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase/browser';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // チャネル割引コード（LL案内リンクに ?code=LL2026 で埋め込まれる）を引き継ぐ
  const code = searchParams.get('code');
  const subscribeHref = code ? `/subscribe?code=${encodeURIComponent(code)}` : '/subscribe';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createBrowserSupabase();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // メール確認が有効な場合は session が無い。確認導線を表示。
    if (!data.session) {
      setDone(true);
      return;
    }
    // 登録完了 → プラン選択（Stripe Checkout）へ
    router.push(subscribeHref);
    router.refresh();
  }

  if (done) {
    return (
      <main style={{ maxWidth: 400, margin: '0 auto', padding: '64px 24px' }}>
        <h1>確認メールを送信しました</h1>
        <p>メール内のリンクで登録を完了してください。</p>
        <p>
          <Link href="/login">ログインへ</Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 400, margin: '0 auto', padding: '64px 24px' }}>
      <h1>新規登録</h1>
      <p style={{ fontSize: 14, color: '#6b6358' }}>14日間無料。まずはアカウント作成から。</p>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <input
          placeholder="お名前"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        <input
          type="password"
          placeholder="パスワード（8文字以上）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          style={{ padding: 10, fontSize: 16 }}
        />
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading} style={{ padding: 12, fontSize: 16 }}>
          {loading ? '...' : '登録する'}
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        既にアカウントをお持ちの方は <Link href="/login">ログイン</Link>
      </p>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
