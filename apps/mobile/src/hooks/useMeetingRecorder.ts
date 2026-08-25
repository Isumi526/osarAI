// PC透明ローカル録音フック（T1）。getDisplayMedia でタブ/画面のシステム音声（相手）を、
// getUserMedia でマイク（自分）を取得し、WebAudio で「自分=左ch / 相手=右ch」のステレオ1本に
// まとめて録音する。会議にボットは入れず、相手には録音が一切見えない（透明）。
// チャンネル分離により、後段(T4)で自分/相手を機械的に切り分けられる。
// 対応: デスクトップ Chrome/Edge のみ（Safari/Firefox は getDisplayMedia の音声不可・iOSは非対応）。
import { useCallback, useRef, useState } from 'react';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];

function pickMimeType(): string | undefined {
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  if (!MR) return undefined;
  return MIME_CANDIDATES.find((t) => MR.isTypeSupported(t));
}

/** iOS/iPadOS 判定（getDisplayMedia 非対応・タッチMac対策で maxTouchPoints も見る）。 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOS;
}

export interface MeetingRecorder {
  recording: boolean;
  error: string | null;
  /** getDisplayMedia が使えるか（デスクトップ Chromium のみ）。 */
  supported: boolean;
  mimeType: string;
  start: () => Promise<boolean>;
  stop: () => Promise<{ blob: Blob; mimeType: string; durationSec: number } | null>;
}

export function useMeetingRecorder(): MeetingRecorder {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>('audio/webm');

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    !isIOS();

  const cleanup = useCallback(() => {
    displayRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    displayRef.current = null;
    micRef.current = null;
    ctxRef.current = null;
    mrRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!supported) {
      setError('この機能はパソコンの Chrome / Edge でご利用ください（Safari・スマホは録音の音声共有に非対応）。');
      return false;
    }
    try {
      // 画面共有ダイアログで「タブ/画面 + 音声を共有」を選んでもらう（相手には何も見えない）。
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      displayRef.current = display;
      const sysAudio = display.getAudioTracks();
      if (sysAudio.length === 0) {
        cleanup();
        setError('相手の音声が取得できませんでした。共有ダイアログで「タブの音声も共有」にチェックを入れてください。');
        return false;
      }
      // 映像は不要なので即停止（音声のみ使う）。
      display.getVideoTracks().forEach((t) => t.stop());

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;

      // WebAudio で 自分(マイク)=左ch / 相手(システム音声)=右ch のステレオにまとめる。
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const micSource = ctx.createMediaStreamSource(mic);
      const sysSource = ctx.createMediaStreamSource(new MediaStream(sysAudio));
      const merger = ctx.createChannelMerger(2);
      micSource.connect(merger, 0, 0); // 左 = 自分
      sysSource.connect(merger, 0, 1); // 右 = 相手
      const dest = ctx.createMediaStreamDestination();
      merger.connect(dest);

      const mimeType = pickMimeType() ?? 'audio/webm';
      mimeRef.current = mimeType;
      const mr = new MediaRecorder(dest.stream, { mimeType });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      // ユーザーがブラウザUIから共有を停止したら録音も止める。
      sysAudio[0]!.addEventListener('ended', () => {
        if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop();
      });
      mr.start(1000); // 1秒ごとにチャンク化（長時間でメモリを分割）
      mrRef.current = mr;
      startedAtRef.current = Date.now();
      setRecording(true);
      return true;
    } catch (e) {
      cleanup();
      // ユーザーが共有をキャンセルした場合も含む
      const msg = e instanceof Error ? e.message : String(e);
      setError(/Permission|denied|NotAllowed/i.test(msg) ? '画面共有がキャンセルされました。' : msg);
      return false;
    }
  }, [supported, cleanup]);

  const stop = useCallback((): Promise<{ blob: Blob; mimeType: string; durationSec: number } | null> => {
    const mr = mrRef.current;
    if (!mr) return Promise.resolve(null);
    return new Promise((resolve) => {
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const durationSec = Math.round((Date.now() - startedAtRef.current) / 1000);
        cleanup();
        setRecording(false);
        resolve(blob.size > 0 ? { blob, mimeType: mimeRef.current, durationSec } : null);
      };
      if (mr.state !== 'inactive') mr.stop();
      else resolve(null);
    });
  }, [cleanup]);

  return { recording, error, supported, mimeType: mimeRef.current, start, stop };
}
