// Settings（プロフィール／通知許可）。※課金導線は置かない（§11 IAP回避）。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { enablePush, isPushSupported } from '../lib/push.js';

export function Settings() {
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onEnablePush() {
    setBusy(true);
    setPushMsg(null);
    try {
      const r = await enablePush();
      setPushMsg(
        r === 'granted'
          ? '通知をオンにしました。「おさらいしよう」のリマインドが届きます。'
          : r === 'denied'
            ? '通知が許可されませんでした。端末の設定から許可してください。'
            : 'この環境ではプッシュ通知は使えません（実機のみ）。',
      );
    } catch (e) {
      setPushMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/">← ホーム</Link>
        <strong>設定</strong>
        <span style={{ width: 48 }} />
      </header>

      <section
        style={{
          background: '#fff',
          border: '1px solid #e7e1d6',
          borderRadius: 12,
          padding: 16,
          marginTop: 16,
        }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>通知</h2>
        <p style={{ margin: '0 0 12px', color: '#6b6358', fontSize: 14 }}>
          人と会ったあと「今日会った人、おさらいする？」を通知でお知らせします（習慣化の中核）。
        </p>
        <button onClick={onEnablePush} disabled={busy} style={{ padding: 12, fontSize: 15 }}>
          {busy ? '設定中…' : '通知をオンにする'}
        </button>
        {!isPushSupported() && (
          <p style={{ margin: '8px 0 0', color: '#9a9183', fontSize: 12 }}>
            ※プッシュ通知は実機アプリでのみ有効です。
          </p>
        )}
        {pushMsg && <p style={{ margin: '8px 0 0', fontSize: 13 }}>{pushMsg}</p>}
      </section>

      <p style={{ marginTop: 16, color: '#9a9183', fontSize: 13 }}>
        課金・プランの管理はWebから行います（アプリ内に決済導線はありません）。
      </p>

      <button
        onClick={() => supabase.auth.signOut()}
        style={{ marginTop: 16, padding: 12, fontSize: 16 }}
      >
        ログアウト
      </button>
    </main>
  );
}
