// 音声録音フック（§8-1 音声入力）。WebView/ブラウザの MediaRecorder を使う。
// ネイティブ実機での録音体裁は ⚠実機確認（CLAUDE.md /review 方針）。
import { useCallback, useRef, useState } from 'react';

// Gemini が扱いやすい順に候補。対応するものを採用。
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];

function pickMimeType(): string | undefined {
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  if (!MR) return undefined;
  return MIME_CANDIDATES.find((t) => MR.isTypeSupported(t));
}

export interface Recorder {
  recording: boolean;
  error: string | null;
  /** 失敗時は ok=false と理由を返す（呼び出し側が古い error state を読む stale closure を避ける・T7）。 */
  start: (opts?: { audioBitsPerSecond?: number }) => Promise<{ ok: boolean; error: string | null }>;
  stop: () => Promise<Blob | null>;
  supported: boolean;
}

export function useRecorder(): Recorder {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const start = useCallback(async (opts?: { audioBitsPerSecond?: number }) => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        ...(opts?.audioBitsPerSecond ? { audioBitsPerSecond: opts.audioBitsPerSecond } : {}),
      });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      // 1秒ごとにチャンク化（会議の長時間録音で1つの巨大Blobにしない）
      mr.start(1000);
      mediaRef.current = mr;
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
        setRecording(false);
        resolve(blob.size > 0 ? blob : null);
      };
      mr.stop();
    });
  }, []);

  return { recording, error, start, stop, supported };
}
