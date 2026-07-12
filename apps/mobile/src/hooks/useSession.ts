import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';

// Web側(決済完了直後)からURLハッシュ経由で渡されたセッションを引き継ぐ。
// フラグメントはサーバーに一切送られないため、決済完了リダイレクト限定の
// 使い捨てハンドオフとして安全。適用後は履歴からハッシュを消す。
async function adoptHandoffSession(): Promise<void> {
  const hash = window.location.hash;
  if (!hash.includes('access_token')) return;
  const params = new URLSearchParams(hash.slice(1));
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (access_token && refresh_token) {
    await supabase.auth.setSession({ access_token, refresh_token });
  }
}

// 認証セッションを購読するフック。session=null は未ログイン。
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adoptHandoffSession().then(() =>
      supabase.auth.getSession().then(({ data }) => {
        setSession(data.session);
        setLoading(false);
      }),
    );
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, loading };
}
