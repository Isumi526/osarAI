// 会議録音のセッションをアプリ全体で1つ持つ（T7c・録音データの死守）。
// - レコーダー（PC: 画面共有＋マイク / スマホ: マイク）は画面ではなくここに常駐させ、
//   録音中に他の画面（予定・つながり等）へ移動しても録音が止まらないようにする。
// - timeslice ごとの Blob は IndexedDB（lib/recording-store）へ逐次保存し、タブを閉じても残す。
// - 画面側（MeetingRecord）は start/stop と状態を読むだけ。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMeetingRecorder, type RecordingResult } from '../hooks/useMeetingRecorder.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { appendChunk, createSession, isRecordingStoreAvailable, updateSession, type RecordingSession } from '../lib/recording-store.js';

// スマホの室内録音は相手の声がスピーカー経由で小さくなりがちなので、少し高めのビットレート
const MOBILE_BITRATE = 96_000;

export type RecordMode = 'pc' | 'mic' | 'none';

export interface MeetingSessionValue {
  mode: RecordMode;
  starting: boolean;
  recording: boolean;
  paused: boolean;
  /** 共有元（Zoom画面/タブ）が閉じられて録音が自動確定した（PC） */
  shareEnded: boolean;
  elapsed: number;
  levels: { self: number; other: number };
  micLevel: number;
  micSilentSec: number;
  /** 現在（または直前）の IndexedDB セッション */
  session: RecordingSession | null;
  start: () => Promise<{ ok: boolean; error: string | null }>;
  /** 録音を止めて結果を返す。IndexedDB のセッションは 'stopped' に更新 */
  stop: () => Promise<(RecordingResult & { sessionId: string | null }) | null>;
  pause: () => void;
  resume: () => void;
  /** 画面側が処理を終えた時に呼ぶ（session をクリア） */
  clearSession: () => void;
}

const Ctx = createContext<MeetingSessionValue | null>(null);

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const pcRec = useMeetingRecorder();
  const micRec = useRecorder();
  const mode: RecordMode = pcRec.supported ? 'pc' : micRec.supported ? 'mic' : 'none';
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recording = mode === 'pc' ? pcRec.recording : micRec.recording;
  const paused = mode === 'pc' ? pcRec.paused : micRec.paused;
  const startedAtRef = useRef(0);
  const pausedAccumRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);

  // 経過時間: 実時間から一時停止分を引く（setInterval の取りこぼしで表示がずれない）
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const pausedNow = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
      setElapsed(Math.max(0, Math.round((Date.now() - startedAtRef.current - pausedAccumRef.current - pausedNow) / 1000)));
    }, 500);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    if (!recording) return;
    if (paused) pausedAtRef.current = Date.now();
    else if (pausedAtRef.current) {
      pausedAccumRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
  }, [paused, recording]);

  const start = useCallback(async () => {
    setStarting(true);
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
    const capture = mode === 'pc' ? 'pc_local' : 'mobile_speaker';
    let sess: RecordingSession | null = null;
    const onChunk = (blob: Blob, index: number, track: 'other' | 'self' = 'other') => {
      if (sess) void appendChunk(sess.id, index, blob, track).catch(() => {});
    };
    try {
      let r: { ok: boolean; error: string | null };
      if (mode === 'pc') r = await pcRec.start({ onChunk });
      else if (mode === 'mic') r = await micRec.start({ audioBitsPerSecond: MOBILE_BITRATE, meter: true, onChunk });
      else r = { ok: false, error: 'この端末では録音できません。' };
      if (!r.ok) return r;
      const mimeType = mode === 'pc' ? pcRec.mimeType : 'audio/webm';
      if (isRecordingStoreAvailable()) {
        try {
          sess = await createSession({ id, mode: mode === 'pc' ? 'pc' : 'mic', capture, mimeType, startedAt: Date.now() });
        } catch {
          sess = null; // 保存できない環境でも録音は続ける
        }
      }
      setSession(sess);
      startedAtRef.current = Date.now();
      pausedAccumRef.current = 0;
      pausedAtRef.current = null;
      setElapsed(0);
      return { ok: true, error: null };
    } finally {
      setStarting(false);
    }
  }, [mode, pcRec, micRec]);

  const stop = useCallback(async () => {
    let rec: RecordingResult | null = null;
    if (mode === 'pc') rec = await pcRec.stop();
    else {
      const blob = await micRec.stop();
      // スマホの室内録音は1本（マイクのみ）。自分/相手の分離はできないので selfBlob は無し。
      if (blob) rec = { blob, selfBlob: null, mimeType: blob.type || 'audio/webm', durationSec: elapsed };
    }
    if (!rec) return null;
    const durationSec = elapsed || rec.durationSec;
    if (session) {
      await updateSession(session.id, { status: 'stopped', durationSec, mimeType: rec.mimeType }).catch(() => {});
      setSession({ ...session, status: 'stopped', durationSec, mimeType: rec.mimeType });
    }
    return { ...rec, durationSec, sessionId: session?.id ?? null };
  }, [mode, pcRec, micRec, elapsed, session]);

  // 録音中はどの画面にいてもタブを閉じる操作に確認を挟む（チャンクは IndexedDB に残るが、
  // 「閉じたら録音が終わる」ことに気づかないまま離脱されるのを防ぐ・T7c）。
  useEffect(() => {
    if (!recording) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [recording]);

  const value: MeetingSessionValue = {
    mode,
    starting,
    recording,
    paused,
    shareEnded: pcRec.shareEnded,
    elapsed,
    levels: pcRec.levels,
    micLevel: micRec.level,
    micSilentSec: micRec.silentSec,
    session,
    start,
    stop,
    pause: () => (mode === 'pc' ? pcRec.pause() : micRec.pause()),
    resume: () => (mode === 'pc' ? pcRec.resume() : micRec.resume()),
    clearSession: () => setSession(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMeetingSession(): MeetingSessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('MeetingSessionProvider が無い');
  return v;
}

export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
