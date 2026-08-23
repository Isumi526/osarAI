// スマホの「ホーム画面に追加」(PWA)を促す案内。ブラウザ(app.osarai.app)から使っている
// 人向け。次のいずれかでは出さない: ①ネイティブアプリ ②既にホーム画面に追加済み(standalone)
// ③ユーザーが「非表示にする」を押した(そのユーザーには以降ずっと出さない)。
// 追加後はstandalone判定で自然に消える。追加を検知できない環境(iOS等)向けに非表示ボタンを持つ。
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { getMyProfile } from '../lib/db.js';

const DISMISS_KEY = 'osarai_a2hs_dismissed';

// Android/Chrome の beforeinstallprompt（型はlib.dom未収載のため最小定義）
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  // iOS Safari は navigator.standalone
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function AddToHomeScreenBanner({ style }: { style?: React.CSSProperties }) {
  const [visible, setVisible] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);

  // 表示可否の判定（ネイティブ/追加済みは即除外。残りはユーザー単位の非表示フラグを見る）
  useEffect(() => {
    if (Capacitor.isNativePlatform() || isStandalone()) return;
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (cancelled) return;
        const key = p ? `${DISMISS_KEY}:${p.id}` : DISMISS_KEY;
        if (p) setUid(p.id);
        setVisible(!localStorage.getItem(key));
      })
      .catch(() => {
        if (!cancelled) setVisible(!localStorage.getItem(DISMISS_KEY));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Android/Chrome では追加プロンプトを直接出せる（発火した場合のみ「追加する」ボタンを見せる）
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!visible) return null;

  function dismiss() {
    localStorage.setItem(uid ? `${DISMISS_KEY}:${uid}` : DISMISS_KEY, '1');
    setVisible(false);
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    if (choice.outcome === 'accepted') setVisible(false);
    setInstallEvent(null);
  }

  return (
    <div
      style={{
        background: 'var(--color-primary-light)',
        border: '1px solid var(--color-primary-border)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        textAlign: 'left',
        ...style,
      }}
    >
      {/* スマホ＋プラスの簡易アイコン（自作SVG・ライセンス懸念なし） */}
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
        <path d="M10.5 5.5h3" />
        <path d="M12 10v6M9 13h6" />
      </svg>
      <div style={{ flex: 1, display: 'grid', gap: 6 }}>
        <strong style={{ fontSize: 15 }}>ホーム画面に追加すると、もっと便利に</strong>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
          {isIOS() ? (
            <>
              Safari下部の「共有」ボタン
              <span aria-hidden="true"> ⬆️ </span>
              から <strong>「ホーム画面に追加」</strong> を選ぶと、アプリのように1タップで開けます。
            </>
          ) : (
            <>
              ブラウザのメニューから <strong>「ホーム画面に追加」</strong> を選ぶと、アプリのように1タップで開けます。
            </>
          )}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
          {installEvent && (
            <button type="button" onClick={install} style={{ padding: '8px 16px', fontSize: 14 }}>
              追加する
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            style={{
              padding: '8px 12px',
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              fontSize: 13,
              minHeight: 'auto',
            }}
          >
            今後表示しない
          </button>
        </div>
      </div>
    </div>
  );
}
