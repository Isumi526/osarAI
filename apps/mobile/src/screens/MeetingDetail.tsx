// 保存済みの会議1件（T8・2026-09-22）。議事録をその場で直せて、相手のカードへ飛べる。
// 承認は無いので「開く＝読む・直す」だけ。全文は折りたたみ（普段は議事録しか読まない）。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteMeetingAudio, getMeeting, getMeetingAudio, updateMeetingMinutes, type MeetingAudioTrack, type SavedMeeting } from '../lib/meeting.js';
import { listCustomers, type Customer } from '../lib/db.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { MinutesBlock } from '../components/ReviewCard.js';
import { fmtSec } from '../components/MeetingSession.js';

export function MeetingDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [row, setRow] = useState<SavedMeeting | null>(null);
  const [minutes, setMinutes] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 音声（録音の保存方針・2026-11-02）：契約中は聞き返せて、会議ごとに消せる
  const [tracks, setTracks] = useState<MeetingAudioTrack[] | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);

  useEffect(() => {
    getMeeting(id)
      .then(async (r) => {
        setRow(r);
        setMinutes(r?.minutes ?? '');
        if (r?.customer_id) {
          const cs = await listCustomers({ status: 'active' }).catch(() => []);
          setCustomer(cs.find((c) => c.id === r.customer_id) ?? null);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    getMeetingAudio(id)
      .then(setTracks)
      .catch(() => setTracks([]));
  }, [id]);

  async function onDeleteAudio() {
    if (!window.confirm('この会議の音声を消しますか？議事録と文字起こしは残ります。消した音声は元に戻せません。')) return;
    setAudioBusy(true);
    try {
      await deleteMeetingAudio(id);
      setTracks([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAudioBusy(false);
    }
  }

  // 議事録の編集は1秒デバウンスで自動保存（保存直後の画面と同じ挙動）
  function onEdit(v: string) {
    setMinutes(v);
    setSaving('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await updateMeetingMinutes(id, v);
        setSaving('saved');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSaving('idle');
      }
    }, 1000);
  }

  return (
    <main className="screen">
      <ScreenHeader title="会議" back={{ to: '/meetings', label: '会議の記録へ戻る' }} />

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {loading ? (
        <p style={{ color: 'var(--color-text-muted)' }}>読み込み中…</p>
      ) : !row ? (
        <p style={{ color: 'var(--color-text-muted)' }}>この会議は見つかりませんでした。</p>
      ) : (
        <section style={{ display: 'grid', gap: 14, padding: 16, background: '#fff', borderRadius: 12, border: '1px solid var(--color-border)' }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              {new Date(row.created_at).toLocaleString('ja-JP')}
              {row.duration_sec ? `・${fmtSec(row.duration_sec)}` : ''}
            </span>
            {customer ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => navigate(`/customers/${customer.id}`)} style={{ flex: 1, minHeight: 44 }}>
                  {customer.name} のカードを見る
                </button>
                {/* 相手の履歴（この会議の議事録を含む）を読み込んだ相談画面へ */}
                <button
                  type="button"
                  onClick={() => navigate(`/chat?customerId=${customer.id}&name=${encodeURIComponent(customer.name)}`)}
                  style={{ minHeight: 44, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                >
                  この会議を踏まえて相談
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>相手が未特定の会議です。</span>
            )}
          </div>

          <MinutesBlock minutes={minutes} onChange={onEdit} />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {saving === 'saving' ? '保存中…' : saving === 'saved' ? '変更を保存しました' : '「編集」で直せます。変更は自動で保存されます。'}
          </span>

          {tracks && tracks.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>録音</span>
              {tracks.map((t) => (
                <div key={t.label} style={{ display: 'grid', gap: 2 }}>
                  {tracks.length > 1 && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t.label}</span>}
                  <audio controls preload="none" src={t.url} style={{ width: '100%' }} />
                </div>
              ))}
              <button
                type="button"
                onClick={onDeleteAudio}
                disabled={audioBusy}
                style={{ justifySelf: 'start', minHeight: 40, background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}
              >
                {audioBusy ? '消しています…' : '音声を消す'}
              </button>
            </div>
          )}

          {row.transcript && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>文字起こし（全文）</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, marginTop: 8 }}>{row.transcript}</pre>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
