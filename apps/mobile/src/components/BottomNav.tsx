// 画面下部固定のナビゲーションバー。全画面で常時表示する。
// アクティブ判定は「現在地に最も近いタブ」（例: /customers/:id ではどのタブも非アクティブ、
// /schedule 配下は予定タブ）。対話画面(Osarai/AiChat/SelfOsarai)は main の高さを
// ナビ分減らしているため入力欄がナビと干渉しない。
import { useLocation, useNavigate } from 'react-router-dom';
import { HomeIcon, ScheduleIcon, OsaraiIcon, ChatIcon, SettingsIcon } from './NavIcons.js';
import { useNavGuardDirty } from './NavGuard.js';
import { useConfirm } from './ConfirmDialog.js';

export const BOTTOM_NAV_HEIGHT = 56;

const TABS = [
  { path: '/', label: 'ホーム', Icon: HomeIcon },
  { path: '/osarai', label: 'おさらい', Icon: OsaraiIcon },
  { path: '/schedule', label: '予定', Icon: ScheduleIcon },
  { path: '/chat', label: '相談', Icon: ChatIcon },
  { path: '/settings', label: 'マイページ', Icon: SettingsIcon },
];

export function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isDirty = useNavGuardDirty();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // 編集中(チャット系画面の未送信入力/未保存セッション)にタブ移動しようとした場合、
  // 確認ダイアログを挟んでから遷移する(議事録要望「下部ナビタップ時なども同様」)。
  async function onTabClick(e: React.MouseEvent, path: string) {
    e.preventDefault();
    if (path === pathname) return;
    if (isDirty) {
      const ok = await confirm('ここまでの内容はまだ保存されていません。このまま移動しますか？（内容は失われます）');
      if (!ok) return;
    }
    navigate(path);
  }

  return (
    <>
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
            <a
              key={tab.path}
              href={tab.path}
              onClick={(e) => onTabClick(e, tab.path)}
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
            </a>
          );
        })}
      </nav>
      {confirmDialog}
    </>
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
