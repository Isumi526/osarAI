// アプリ内通知の一覧（2026-09-08）。2タブ構成。
// タブの区切りは「どう届いたか」ではなく「何の通知か」。将来プッシュ通知やLINE連携に
// 広がっても同じ分け方で通るようにする（議事録の「アプリ内通知という言葉を使いましたけど、
// まあ、通知ですね」＝チャネルは後から増える前提）。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import {
  listNotifications,
  markAllRead,
  markRead,
  type AppNotification,
  type NotificationCategory,
} from '../lib/notifications.js';

const TABS: { key: NotificationCategory; label: string }[] = [
  { key: 'reminder', label: 'リマインド' },
  { key: 'announce', label: 'お知らせ' },
];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}時間前`;
  return d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });
}

export function Notifications() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<NotificationCategory>('reminder');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (category: NotificationCategory) => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listNotifications(category));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function open(n: AppNotification) {
    // 開いたものだけ既読にする（一覧を見ただけで全部消えると見落とすため）
    if (!n.read_at) {
      try {
        await markRead(n.id);
        setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      } catch {
        /* 既読化の失敗で遷移を止めない */
      }
    }
    if (n.link_path) navigate(n.link_path);
  }

  const unreadInTab = items.filter((i) => !i.read_at).length;

  return (
    <main className="screen" style={{ paddingBottom: BOTTOM_NAV_HEIGHT + 24 }}>
      <ScreenHeader>
        <button
          type="button"
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}
        >
          ← ホーム
        </button>
        <strong>通知</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      <div style={{ display: 'flex', gap: 8, margin: '4px 0 12px' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              flex: 1,
              padding: '10px 12px',
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 999,
              background: tab === t.key ? 'var(--color-primary)' : '#fff',
              color: tab === t.key ? '#fff' : 'var(--color-text-muted)',
              border: `1px solid ${tab === t.key ? 'var(--color-primary)' : 'var(--color-border)'}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {unreadInTab > 0 && (
        <button
          type="button"
          onClick={async () => {
            await markAllRead(tab);
            await load(tab);
          }}
          style={{
            alignSelf: 'flex-end',
            marginBottom: 8,
            padding: '6px 10px',
            fontSize: 12,
            background: 'none',
            border: '1px solid var(--color-border)',
            borderRadius: 999,
            color: 'var(--color-text-muted)',
          }}
        >
          すべて既読にする
        </button>
      )}

      {loading && <p style={{ color: 'var(--color-text-muted)' }}>読み込み中…</p>}
      {error && <p style={{ color: 'var(--color-danger, #c0392b)', fontSize: 14 }}>{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
          {tab === 'reminder'
            ? 'まだリマインドはありません。人と会ったあとに話した内容から、約束や予定をここでお知らせします。'
            : 'まだお知らせはありません。'}
        </p>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => void open(n)}
            style={{
              textAlign: 'left',
              padding: 12,
              borderRadius: 10,
              background: n.read_at ? '#fff' : 'var(--color-surface-subtle, #fff7f0)',
              border: `1px solid ${n.read_at ? 'var(--color-border)' : 'var(--color-primary)'}`,
              display: 'grid',
              gap: 4,
            }}
          >
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 14 }}>{n.title}</strong>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                {formatWhen(n.created_at)}
              </span>
            </span>
            {n.body && (
              <span style={{ fontSize: 13, color: 'var(--color-text)', whiteSpace: 'pre-wrap' }}>{n.body}</span>
            )}
          </button>
        ))}
      </div>
    </main>
  );
}
