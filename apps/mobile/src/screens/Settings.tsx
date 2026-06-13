// Settings（プロフィール／通知許可）。※課金導線は置かない（§11 IAP回避）。
import { supabase } from '../lib/supabase.js';

export function Settings() {
  return (
    <main className="screen">
      <h1>設定</h1>
      <p>プロフィール／通知許可。課金導線はアプリ内に置かない（Web完結）。</p>
      <button
        onClick={() => supabase.auth.signOut()}
        style={{ marginTop: 16, padding: 12, fontSize: 16 }}
      >
        ログアウト
      </button>
    </main>
  );
}
