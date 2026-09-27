// 画面下部固定のナビゲーションバー。全画面で常時表示する。
// アクティブ判定は「現在地に最も近いタブ」（例: /customers/:id ではどのタブも非アクティブ、
// /schedule 配下は予定タブ）。対話画面(Osarai/AiChat/SelfOsarai)は main の高さを
// ナビ分減らしているため入力欄がナビと干渉しない。
import { useLocation, useNavigate } from 'react-router-dom';
import { HomeIcon, ScheduleIcon, TaskIcon, SettingsIcon } from './NavIcons.js';
import { useNavGuardDirty } from './NavGuard.js';
import { useConfirm } from './ConfirmDialog.js';
import { useMeetingSession, fmtSec } from './MeetingSession.js';
import { isMeetingSetupDone } from '../lib/meetingSetup.js';
import { getSavedMicId } from './MicPicker.js';

export const BOTTOM_NAV_HEIGHT = 56;
/** 中央の録音ボタンがナビの上にはみ出す高さ。固定の入力欄などはこの分だけ上に置く */
export const NAV_OVERHANG = 30;

// 2026-09-27: 会議録音が主導線になったので、中央に大きな録音ボタンを置く（人判断）。
// 左右に2タブずつ。AIと話すはタブにせず、ホームや相手のカードなど文脈のある場所から入る。
const LEFT_TABS = [
  { path: '/', label: 'ホーム', Icon: HomeIcon },
  { path: '/schedule', label: '予定', Icon: ScheduleIcon },
];
const RIGHT_TABS = [
  { path: '/tasks', label: 'TODO', Icon: TaskIcon },
  { path: '/settings', label: 'マイページ', Icon: SettingsIcon },
];
// 中央ボタンの直径。他タブのアイコン（約24px）と同じ高さだけ流れに残し、残りをバーの上へはみ出させる
// （こうするとラベルの高さが他のタブと揃う）。
const RECORD_SIZE = 56;
const ICON_SLOT = 20;

export function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isDirty = useNavGuardDirty();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const ms = useMeetingSession();

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

  /**
   * 中央の録音ボタン。2回目以降（準備済みの端末）は押した時点でそのまま録音を始める（2026-09-27）。
   * 画面共有・マイクの許可はユーザー操作の直後でないと出せないので、画面遷移を待たずにここで開始する。
   */
  async function onRecordClick(e: React.MouseEvent) {
    e.preventDefault();
    if (ms.recording || ms.starting || !isMeetingSetupDone() || ms.mode === 'none') {
      await onTabClick(e, '/meeting');
      return;
    }
    if (isDirty) {
      const ok = await confirm('ここまでの内容はまだ保存されていません。このまま録音を始めますか？（内容は失われます）');
      if (!ok) return;
    }
    const started = ms.start({ micDeviceId: getSavedMicId() });
    navigate('/meeting');
    const r = await started;
    if (!r.ok) navigate('/meeting', { replace: true, state: { startError: r.error } });
  }

  function renderTab(tab: (typeof LEFT_TABS)[number]) {
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
        {LEFT_TABS.map(renderTab)}
        {/* 中央の録音ボタン。録音中は赤くなり経過時間を出す＝どの画面からでも録音画面へ戻れる */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 0', minHeight: BOTTOM_NAV_HEIGHT }}>
          <button
            type="button"
            onClick={(e) => void onRecordClick(e)}
            aria-label={ms.recording ? `録音中 ${fmtSec(ms.elapsed)}・録音画面へ` : '会議を録音する'}
            style={{
              width: RECORD_SIZE,
              height: RECORD_SIZE,
              marginTop: -(RECORD_SIZE - ICON_SLOT),
              flexShrink: 0,
              borderRadius: '50%',
              border: '4px solid var(--color-surface)',
              background: ms.recording ? (ms.paused ? '#6b6358' : '#c0392b') : 'var(--color-primary)',
              color: '#fff',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            }}
          >
            {ms.recording ? (
              <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtSec(ms.elapsed)}</span>
            ) : (
              <MicGlyph />
            )}
          </button>
          <span
            style={{
              fontSize: 12,
              fontWeight: pathname === '/meeting' ? 700 : 400,
              color: ms.recording ? '#c0392b' : 'var(--color-primary)',
            }}
          >
            {ms.recording ? (ms.paused ? '一時停止中' : '録音中') : '録音'}
          </span>
        </div>
        {RIGHT_TABS.map(renderTab)}
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

/** 録音ボタンのマイク（ナビのアイコンと同じ線画スタイル） */
function MicGlyph() {
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}
