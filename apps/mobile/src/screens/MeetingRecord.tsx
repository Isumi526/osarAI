// 会議録音（T1・PC透明ローカル録音）。Zoom/Meet を開いたまま、相手にボットを見せず、
// タブ/画面のシステム音声（相手）＋マイク（自分）を録音 → 文字起こし → 3データ抽出 →
// 既存 ReviewCard で承認 → 登録。デスクトップ Chrome/Edge 向け（スマホ経路は T2）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import { ReviewCard } from '../components/ReviewCard.js';
import { useMeetingRecorder } from '../hooks/useMeetingRecorder.js';
import { uploadMeetingAudio, ingestMeeting, commitMeeting } from '../lib/meeting.js';
import type { Proposals } from '../lib/assistant.js';

type Phase = 'idle' | 'recording' | 'processing' | 'reviewing' | 'committed';

const EMPTY: Proposals = { people: [], schedules: [], tasks: [], self_notes: [], self_fields: {} };

export function MeetingRecord() {
  const navigate = useNavigate();
  const recorder = useMeetingRecorder();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [proposals, setProposals] = useState<Proposals>(EMPTY);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase === 'recording') {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  async function onStart() {
    setError(null);
    const ok = await recorder.start();
    if (!ok) {
      setError(recorder.error);
      return;
    }
    setPhase('recording');
  }

  async function onStop() {
    const rec = await recorder.stop();
    if (!rec) {
      setError('録音を取得できませんでした。もう一度お試しください。');
      setPhase('idle');
      return;
    }
    setPhase('processing');
    setError(null);
    try {
      const path = await uploadMeetingAudio(rec.blob, rec.mimeType);
      const res = await ingestMeeting({
        recordingPath: path,
        mimeType: rec.mimeType,
        capture: 'pc_local',
        durationSec: rec.durationSec,
      });
      setMeetingId(res.meetingId);
      setProposals(res.proposals ?? EMPTY);
      setMinutes(res.minutes);
      setPhase('reviewing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  async function onCommit() {
    if (!meetingId || committing) return;
    const unnamed = proposals.people.find((p) => !p.customer_id && !p.name.trim());
    if (unnamed) {
      setError('お名前を入力してください。');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      await commitMeeting({ meetingId, proposals, minutes });
      setPhase('committed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <main style={{ paddingBottom: BOTTOM_NAV_HEIGHT + 24 }}>
      <ScreenHeader>
        <button type="button" onClick={() => navigate('/')} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}>
          ← ホーム
        </button>
        <strong>会議を録音する</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>
      <div style={{ padding: 16, display: 'grid', gap: 16 }}>
        {error && (
          <p style={{ color: 'var(--color-danger, #c0392b)', fontSize: 14, margin: 0 }}>{error}</p>
        )}

        {phase === 'idle' && (
          <>
            {!recorder.supported ? (
              <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
                <strong>この端末では会議録音を使えません</strong>
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
                  会議の音声録音は、パソコンの <b>Chrome / Edge</b> でご利用ください。
                  Safari やスマホ・iPad のブラウザは、相手の音声の取り込みに対応していません
                  （スマホでの録音は別途対応予定です）。
                </p>
              </section>
            ) : (
              <>
                <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
                  <strong>使い方</strong>
                  <ol style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
                    <li>Zoom / Meet を開いたまま「録音を開始」を押す</li>
                    <li>共有ダイアログで会議のタブ（または画面）を選び、<b>「タブの音声も共有」にチェック</b></li>
                    <li>会議が終わったら「停止して解析」。相手にはボットも通知も一切表示されません</li>
                  </ol>
                </section>
                <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
                  録音を開始
                </button>
              </>
            )}
          </>
        )}

        {phase === 'recording' && (
          <section style={{ display: 'grid', gap: 16, placeItems: 'center', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#c0392b', display: 'inline-block' }} />
              録音中
            </div>
            <div style={{ fontSize: 32, fontVariantNumeric: 'tabular-nums' }}>{fmt(elapsed)}</div>
            <button type="button" onClick={onStop} style={{ minHeight: 52, fontSize: 16, width: '100%' }}>
              停止して解析
            </button>
          </section>
        )}

        {phase === 'processing' && (
          <section style={{ display: 'grid', gap: 8, placeItems: 'center', padding: 32 }}>
            <div style={{ fontSize: 16 }}>文字起こし・解析中…</div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center' }}>
              長い会議ほど時間がかかります（数分かかることがあります）。このまま少しお待ちください。
            </p>
          </section>
        )}

        {phase === 'reviewing' && (
          <ReviewCard
            proposals={proposals}
            setProposals={setProposals}
            committing={committing}
            onCommit={onCommit}
            onBackToChat={() => {
              setPhase('idle');
              setProposals(EMPTY);
              setMinutes(null);
              setMeetingId(null);
            }}
            backLabel="録り直す"
            minutes={minutes}
          />
        )}

        {phase === 'committed' && (
          <section style={{ display: 'grid', gap: 16, placeItems: 'center', padding: 24 }}>
            <div style={{ fontSize: 18 }}>登録しました</div>
            <button type="button" onClick={() => navigate('/')} style={{ minHeight: 48, width: '100%' }}>
              ホームへ
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
