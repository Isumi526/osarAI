// 保存されていない録音のお知らせ（2026-09-27）。以前は録音ページの「前回の続き」にあったが、
// 録音ページは急いで押す場所なので、ホームと「会議の記録」の先頭に移した（人判断）。
// - 端末に残っている録音（録音中に閉じた・アップロード前・解析前）
// - サーバーに残っている未保存の解析結果（自動保存に失敗したもの）
// 1タップで録音ページに渡して続きを処理する（勝手に送信・保存はしない）。無ければ何も出さない。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteSession, listPendingSessions, purgeOldSessions, type RecordingSession } from '../lib/recording-store.js';
import { listReviewingMeetings } from '../lib/meeting.js';
import { useMeetingSession, fmtSec } from './MeetingSession.js';
import { useConfirm } from './ConfirmDialog.js';

type Item =
  | { kind: 'device'; id: string; at: number; durationSec: number | null; session: RecordingSession }
  | { kind: 'server'; id: string; at: number; durationSec: number | null };

export function PendingRecordingsBanner() {
  const navigate = useNavigate();
  const ms = useMeetingSession();
  const { confirm, dialog } = useConfirm();
  const [items, setItems] = useState<Item[]>([]);

  const load = useCallback(async () => {
    const out: Item[] = [];
    try {
      await purgeOldSessions();
      for (const s of await listPendingSessions()) {
        // 今まさに録音中のセッションは「途中で止まった録音」ではない
        if (ms.session?.id === s.id && (ms.recording || ms.starting)) continue;
        out.push({
          kind: 'device',
          id: s.id,
          at: s.startedAt,
          durationSec: s.durationSec ?? Math.round((s.updatedAt - s.startedAt) / 1000),
          session: s,
        });
      }
    } catch {
      /* IndexedDB が使えない環境では端末側は無し */
    }
    try {
      const rows = await listReviewingMeetings();
      for (const r of rows) {
        if (out.some((x) => x.kind === 'device' && x.session.meetingId === r.id)) continue;
        out.push({ kind: 'server', id: r.id, at: Date.parse(r.created_at), durationSec: r.duration_sec });
      }
    } catch {
      /* 取れなければ出さない */
    }
    setItems(out.sort((a, b) => b.at - a.at));
  }, [ms.session?.id, ms.recording, ms.starting]);

  useEffect(() => {
    void load();
  }, [load]);

  if (items.length === 0) return null;

  return (
    <section
      style={{
        padding: 14,
        margin: '12px 0 0',
        background: '#fff7f0',
        border: '1px solid var(--color-primary)',
        borderRadius: 12,
        display: 'grid',
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 15 }}>保存されていない録音があります</strong>
      {items.map((it) => (
        <div key={`${it.kind}-${it.id}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 160, fontSize: 13 }}>
            {new Date(it.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} の録音
            {it.durationSec ? `（${fmtSec(it.durationSec)}）` : ''}
          </span>
          <button
            type="button"
            onClick={() => navigate(it.kind === 'device' ? `/meeting?recover=${it.id}` : `/meeting?unsaved=${it.id}`)}
            style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
          >
            保存する
          </button>
          {it.kind === 'device' && (
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm('この録音を破棄しますか？（元に戻せません）');
                if (!ok) return;
                await deleteSession(it.id).catch(() => {});
                await load();
              }}
              style={{ minHeight: 36, padding: '0 12px', fontSize: 13, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              破棄
            </button>
          )}
        </div>
      ))}
      {dialog}
    </section>
  );
}
