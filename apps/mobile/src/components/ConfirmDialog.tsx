// アプリ独自デザインの確認ダイアログ。window.confirm() の代替。
// useConfirm() が返す confirm(message) を await すると、ユーザーがOK/キャンセルを
// 選ぶまで解決しない Promise<boolean> を返す（window.confirm と同じ使い勝手）。
import { useCallback, useState } from 'react';

interface PendingConfirm {
  message: string;
  resolve: (ok: boolean) => void;
}

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => setPending({ message, resolve }));
  }, []);

  function answer(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  const dialog = pending ? (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(42,38,34,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
          maxWidth: 340,
          width: '100%',
        }}
      >
        <p style={{ margin: '0 0 20px', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{pending.message}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => answer(false)}
            style={{ flex: 1, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            キャンセル
          </button>
          <button onClick={() => answer(true)} style={{ flex: 1 }}>
            OK
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
