// 保存済みの会議一覧（T8・2026-09-22）。
// 承認ステップを廃止して自動保存になったので、「あの会議どこ行った」を拾う入口がここ。
// 相手が分かっている会議はその人のカードからも読めるが、相手未特定の会議はここにしか出ない。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listSavedMeetings, type SavedMeeting } from '../lib/meeting.js';
import { listCustomers, type Customer } from '../lib/db.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { fmtSec } from '../components/MeetingSession.js';
import { PendingRecordingsBanner } from '../components/PendingRecordingsBanner.js';

/** 議事録の冒頭から、一覧に出す1行の要約を作る（見出し行と空行は飛ばす）。 */
function firstLine(minutes: string | null): string {
  if (!minutes) return '議事録なし';
  for (const raw of minutes.split('\n')) {
    const l = raw.replace(/^[-・*]\s*/, '').trim();
    if (!l || /^【.+】$/u.test(l)) continue;
    return l.length > 48 ? `${l.slice(0, 48)}…` : l;
  }
  return '議事録なし';
}

export function MeetingList() {
  const [rows, setRows] = useState<SavedMeeting[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listSavedMeetings()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    listCustomers({ status: 'active' })
      .then(setCustomers)
      .catch(() => undefined); // 名前が出せなくても一覧自体は使える
  }, []);

  const nameOf = (id: string | null) => (id ? (customers.find((c) => c.id === id)?.name ?? null) : null);

  return (
    <main className="screen screen--wide">
      <ScreenHeader>
        <Link to="/" className="back-home">← ホーム</Link>
        <strong>会議の記録</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      <PendingRecordingsBanner />
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>読み込み中…</p>
      ) : rows.length === 0 ? (
        <section style={{ display: 'grid', gap: 12, padding: 16 }}>
          <p style={{ color: 'var(--color-text-muted)' }}>まだ保存された会議はありません。</p>
          <button type="button" onClick={() => navigate('/meeting')} style={{ minHeight: 48 }}>
            会議を録音する
          </button>
        </section>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {rows.map((r) => {
            const nm = nameOf(r.customer_id);
            return (
              <li key={r.id}>
                <Link
                  to={`/meetings/${r.id}`}
                  style={{
                    display: 'grid', gap: 4, padding: 14, background: '#fff', borderRadius: 12,
                    border: '1px solid var(--color-border)', textDecoration: 'none', color: 'var(--color-text)',
                  }}
                >
                  <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: 'var(--color-text-muted)' }}>
                    <span>{new Date(r.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    <span>{r.duration_sec ? fmtSec(r.duration_sec) : ''}</span>
                  </span>
                  <strong style={{ fontSize: 15 }}>{nm ?? '相手が未特定の会議'}</strong>
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{firstLine(r.minutes)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
