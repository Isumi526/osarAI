// Login（Supabase Auth・メール/パスワード）。サインアップは DBトリガーで
// LL組織・member の profile が自動生成される（migration 0003）。
import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

export function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfo(null);
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      // 成功時は onAuthStateChange が App を再描画 → Home へ
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name } },
      });
      if (error) setError(error.message);
      else if (!data.session) setInfo('確認メールを送りました。メールのリンクで登録を完了してください。');
    }
    setLoading(false);
  }

  return (
    <main className="screen">
      <h1>osarAI 〜おさらい〜</h1>
      <p>{mode === 'login' ? 'ログイン' : '新規登録'}</p>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        {mode === 'signup' && (
          <input
            placeholder="ニックネーム"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{ padding: 12, fontSize: 16 }}
          />
        )}
        <input
          type="email"
          placeholder="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 12, fontSize: 16 }}
        />
        <input
          type="password"
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          style={{ padding: 12, fontSize: 16 }}
        />
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        {info && <p style={{ color: '#2d7d46', margin: 0 }}>{info}</p>}
        <button type="submit" disabled={loading} style={{ padding: 14, fontSize: 16 }}>
          {loading ? '...' : mode === 'login' ? 'ログイン' : '登録する'}
        </button>
      </form>
      <button
        onClick={() => {
          setMode(mode === 'login' ? 'signup' : 'login');
          setError(null);
          setInfo(null);
        }}
        style={{ marginTop: 16, background: 'none', border: 'none', color: '#3a6ea5' }}
      >
        {mode === 'login' ? 'アカウントを作る' : 'ログインに戻る'}
      </button>
    </main>
  );
}
