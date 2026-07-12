'use client';

// 新規登録（メール＋パスワード）。サインアップで auth.users 作成 → DBトリガーが
// profiles を LL組織・member で自動生成（migration 0003）。
// ※フェーズ4でこの後段に Stripe Checkout（14日トライアル）を挿入する。
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase/browser';
import { Spinner } from '@/components/Spinner';
import { toJaAuthError } from '@/lib/auth-errors';
import { PasswordInput } from '@/components/PasswordInput';

function SignupForm() {
  const searchParams = useSearchParams();
  // チャネル割引コード（LL案内リンクに ?code=LL2026 で埋め込まれる）を引き継ぐ
  const code = searchParams.get('code');
  const subscribeHref = code ? `/subscribe?code=${encodeURIComponent(code)}` : '/subscribe';
  // 紹介コード（LP等から ?ref=CODE で引き継がれる）。signUpのメタデータに乗せ、
  // handle_new_user()トリガーがreferred_byを解決する（不正/存在しないコードは無視される）。
  const ref = searchParams.get('ref');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) {
      setError('利用規約への同意が必要です。');
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createBrowserSupabase();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name, ...(ref ? { ref } : {}), ...(code ? { code } : {}) } },
    });
    if (error) {
      setLoading(false);
      setError(toJaAuthError(error.message));
      return;
    }
    // メール確認が有効な場合は session が無い。確認導線を表示。
    if (!data.session) {
      setLoading(false);
      setDone(true);
      return;
    }
    // 登録完了 → プラン選択へ。ハードナビゲーションで遷移する（router.push だと
    // 初回はサーバーが新しい認証クッキーを認識できず戻される場合があるため。
    // login と同じ @supabase/ssr のクッキー伝播レース対策）。loading は解除しない。
    window.location.assign(subscribeHref);
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
          placeholder="ニックネーム"
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
        <PasswordInput value={password} onChange={setPassword} placeholder="パスワード（8文字以上）" minLength={8} required />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <Link href="/terms" target="_blank">
            利用規約
          </Link>
          に同意する
        </label>
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading || !agreed} style={{ padding: 12, fontSize: 16 }}>
          {loading ? <Spinner /> : '登録する'}
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
