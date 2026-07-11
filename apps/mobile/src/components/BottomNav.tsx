// 画面下部固定のナビゲーションバー。全画面で常時表示する。
// アクティブ判定は「現在地に最も近いタブ」（例: /customers/:id ではどのタブも非アクティブ、
// /schedule 配下は予定タブ）。対話画面(Osarai/AiChat/SelfOsarai)は main の高さを
// ナビ分減らしているため入力欄がナビと干渉しない。
import { Link, useLocation } from 'react-router-dom';
import { HomeIcon, ScheduleIcon, ChatIcon, SettingsIcon } from './NavIcons.js';

export const BOTTOM_NAV_HEIGHT = 56;

const TABS = [
  { path: '/', label: 'ホーム', Icon: HomeIcon },
  { path: '/schedule', label: '予定', Icon: ScheduleIcon },
  { path: '/chat', label: '相談', Icon: ChatIcon },
  { path: '/settings', label: '設定', Icon: SettingsIcon },
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
        const { Icon } = tab;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '8px 0',
              minHeight: BOTTOM_NAV_HEIGHT,
              color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
              fontWeight: active ? 700 : 400,
              fontSize: 12,
              textDecoration: 'none',
            }}
          >
            <Icon active={active} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

// 全画面で常時表示だが、初回オンボーディング(離脱防止)に限り例外的に非表示にする:
// ①ウェルカム画面(/welcome) ②そこから遷移した初回の自分をおさらいする(/self-osarai?from=welcome)。
// 通常のsettings経由での自分をおさらいするでは引き続き表示する(意図的な例外・全画面表示の一般ルールは維持)。
export function useBottomNavVisible() {
  const { pathname, search } = useLocation();
  if (pathname === '/welcome') return false;
  if (pathname === '/self-osarai' && new URLSearchParams(search).get('from') === 'welcome') return false;
  return true;
}
