// 音声録音フック（§8-1 音声入力）。WebView/ブラウザの MediaRecorder を使う。
// ネイティブ実機での録音体裁は ⚠実機確認（CLAUDE.md /review 方針）。
import { useCallback, useRef, useState } from 'react';
import { readLevel, SILENCE_LEVEL } from './useMeetingRecorder.js';

// Gemini が扱いやすい順に候補。対応するものを採用。
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];

function pickMimeType(): string | undefined {
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  if (!MR) return undefined;
  return MIME_CANDIDATES.find((t) => MR.isTypeSupported(t));
}

export interface Recorder {
  recording: boolean;
  /** 一時停止中（会議録音の離席用・T7b） */
  paused: boolean;
  /** マイク入力レベル（0〜1）。meter:true で start した時だけ更新される */
  level: number;
  /** 無音のまま経過した秒数（meter:true 時） */
  silentSec: number;
  error: string | null;
  /** 失敗時は ok=false と理由を返す（呼び出し側が古い error state を読む stale closure を避ける・T7）。 */
  start: (opts?: { audioBitsPerSecond?: number; meter?: boolean; onChunk?: (blob: Blob, index: number) => void }) => Promise<{ ok: boolean; error: string | null }>;
  stop: () => Promise<Blob | null>;
  pause: () => void;
  resume: () => void;
  supported: boolean;
}

export function useRecorder(): Recorder {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState(0);
  const [silentSec, setSilentSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const start = useCallback(async (opts?: { audioBitsPerSecond?: number; meter?: boolean; onChunk?: (blob: Blob, index: number) => void }) => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      if (opts?.meter && typeof AudioContext !== 'undefined') {
        // レベルメーター（録音経路とは独立・MediaRecorder はストリームを直接使う）
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(1024) as Float32Array<ArrayBuffer>;
        let silentSince = Date.now();
        setSilentSec(0);
        meterRef.current = setInterval(() => {
          if (mediaRef.current?.state === 'paused') return;
          const v = readLevel(an, buf);
          setLevel(v);
          if (v > SILENCE_LEVEL) {
            silentSince = Date.now();
            setSilentSec(0);
          } else {
            setSilentSec(Math.round((Date.now() - silentSince) / 1000));
          }
        }, 200);
      }
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        ...(opts?.audioBitsPerSecond ? { audioBitsPerSecond: opts.audioBitsPerSecond } : {}),
      });
      chunksRef.current = [];
      let chunkIndex = 0;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          try {
            opts?.onChunk?.(e.data, chunkIndex++);
          } catch {
            /* 保存失敗で録音は止めない */
          }
        }
      };
      // 1秒ごとにチャンク化（会議の長時間録音で1つの巨大Blobにしない）
      mr.start(1000);
      mediaRef.current = mr;
      setPaused(false);
      setRecording(true);
      return { ok: true, error: null };
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      const raw = e instanceof Error ? e.message : String(e);
      const msg =
        name === 'NotAllowedError'
          ? 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。'
          : name === 'NotFoundError'
            ? 'マイクが見つかりませんでした。'
            : raw;
      setError(msg);
      return { ok: false, error: msg };
    }
  }, []);

  const stop = useCallback((): Promise<Blob | null> => {
    const mr = mediaRef.current;
    if (!mr) return Promise.resolve(null);
    return new Promise((resolve) => {
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        mediaRef.current = null;
        if (meterRef.current) clearInterval(meterRef.current);
        meterRef.current = null;
        ctxRef.current?.close().catch(() => {});
        ctxRef.current = null;
        setRecording(false);
        setPaused(false);
        resolve(blob.size > 0 ? blob : null);
      };
      mr.stop();
    });
  }, []);

  const pause = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state === 'recording') {
      mr.pause();
      setPaused(true);
    }
  }, []);
  const resume = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state === 'paused') {
      mr.resume();
      setPaused(false);
    }
  }, []);

  return { recording, paused, level, silentSec, error, start, stop, pause, resume, supported };
}
