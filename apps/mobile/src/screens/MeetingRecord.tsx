// 会議録音。相手にボットを見せず端末側で録音 → 文字起こし → 3データ抽出 → ReviewCard承認 → 登録。
// - PC(T1): getDisplayMedia でタブ/画面のシステム音声(相手)＋マイク(自分)を分離録音（透明）。
// - スマホ(T2): getDisplayMedia 非対応のためスピーカー再生＋マイクで室内録音（イヤホンは外す）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import { ReviewCard } from '../components/ReviewCard.js';
import { useMeetingRecorder } from '../hooks/useMeetingRecorder.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { uploadMeetingAudio, ingestMeeting, commitMeeting, type MeetingCapture } from '../lib/meeting.js';
import type { Proposals } from '../lib/assistant.js';

type Phase = 'idle' | 'recording' | 'processing' | 'reviewing' | 'committed';

const EMPTY: Proposals = { people: [], schedules: [], tasks: [], self_notes: [], self_fields: {} };

export function MeetingRecord() {
  const navigate = useNavigate();
  const pcRec = useMeetingRecorder();
  const micRec = useRecorder();
  // PCでシステム音声を録れるなら透明モード。無理ならスマホのスピーカー録音にフォールバック。
  const mode: 'pc' | 'mobile' | 'none' = pcRec.supported ? 'pc' : micRec.supported ? 'mobile' : 'none';
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
    if (mode === 'pc') {
      const ok = await pcRec.start();
      if (!ok) {
        setError(pcRec.error);
        return;
      }
    } else if (mode === 'mobile') {
      await micRec.start();
      if (micRec.error) {
        setError(micRec.error);
        return;
      }
    } else {
      return;
    }
    setPhase('recording');
  }

  async function onStop() {
    // モードごとに録音を止めて、共通の {blob, mimeType, durationSec} に正規化する。
    let rec: { blob: Blob; mimeType: string; durationSec: number } | null = null;
    if (mode === 'pc') {
      rec = await pcRec.stop();
    } else {
      const blob = await micRec.stop();
      if (blob) rec = { blob, mimeType: blob.type || 'audio/webm', durationSec: elapsed };
    }
    if (!rec) {
      setError('録音を取得できませんでした。もう一度お試しください。');
      setPhase('idle');
      return;
    }
    setPhase('processing');
    setError(null);
    try {
      const capture: MeetingCapture = mode === 'pc' ? 'pc_local' : 'mobile_speaker';
      const path = await uploadMeetingAudio(rec.blob, rec.mimeType);
      const res = await ingestMeeting({
        recordingPath: path,
        mimeType: rec.mimeType,
        capture,
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

        {phase === 'idle' && mode === 'none' && (
          <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
            <strong>この端末では会議録音を使えません</strong>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
              マイクの使えるブラウザ（パソコンの Chrome / Edge、またはスマホ）でお試しください。
            </p>
          </section>
        )}

        {phase === 'idle' && mode === 'pc' && (
          <>
            <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
              <strong>使い方（パソコン）</strong>
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

        {phase === 'idle' && mode === 'mobile' && (
          <>
            <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
              <strong>使い方（スマホ・タブレット）</strong>
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                スマホでは相手の声を直接取り込めないため、<b>イヤホンを外して端末のスピーカーで会議を再生</b>し、
                室内の音をマイクで録音します。
              </p>
              <ol style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
                <li>イヤホンを外し、Zoom / Meet を<b>スピーカー</b>にする</li>
                <li>「録音を開始」を押す（マイクの許可を求められたら許可）</li>
                <li>会議が終わったら「停止して解析」</li>
              </ol>
            </section>
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
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
