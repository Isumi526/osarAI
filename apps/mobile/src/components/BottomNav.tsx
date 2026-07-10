// 画面下部固定のナビゲーションバー。全画面で常時表示する。
// アクティブ判定は「現在地に最も近いタブ」（例: /customers/:id ではどのタブも非アクティブ、
// /schedule 配下は予定タブ）。対話画面(Osarai/AiChat/SelfOsarai)は main の高さを
// ナビ分減らしているため入力欄がナビと干渉しない。
import { Link, useLocation } from 'react-router-dom';

export const BOTTOM_NAV_HEIGHT = 56;

const TABS = [
  { path: '/', label: 'ホーム' },
  { path: '/schedule', label: '予定' },
  { path: '/chat', label: '相談' },
  { path: '/settings', label: '設定' },
];

export function BottomNav() {
  const { pathname } = useLocation();

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        background: 'var(--color-surface)',
        borderTop: '1px solid var(--color-border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        zIndex: 100,
      }}
    >
      {TABS.map((tab) => {
        const active = pathname === tab.path;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '10px 0',
              minHeight: BOTTOM_NAV_HEIGHT,
              color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
              fontWeight: active ? 700 : 400,
              textDecoration: 'none',
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function useBottomNavVisible() {
  return true; // 全画面で常時表示
}
