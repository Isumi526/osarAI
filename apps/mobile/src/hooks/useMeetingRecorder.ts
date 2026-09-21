// PC透明ローカル録音フック（T1）。getDisplayMedia で画面/タブのシステム音声（相手）を、
// getUserMedia でマイク（自分）を取得し、WebAudio で「自分=左ch / 相手=右ch」のステレオ1本に
// まとめて録音する。会議にボットは入れず、相手には録音が一切見えない（透明）。
// チャンネル分離により、後段(T4)で自分/相手を機械的に切り分けられる。
// 対応: デスクトップ Chrome/Edge のみ（Safari/Firefox は getDisplayMedia の音声不可・iOS/Android は非対応）。
//
// T7: 共有元（Zoom画面/タブ）が先に閉じられて共有トラックが ended になっても録音データを失わない。
//   ended 時点で Blob を確定して pendingRef に保持し、後から stop() が呼ばれてもそれを返す。
//   ユーザーストーリーは「Zoomを閉じてからアプリに戻って停止」の順序なので、ここが要。
import { useCallback, useEffect, useRef, useState } from 'react';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
// 音声会議には十分な品質で、60分 ≒ 29MB（Storage の既定上限 50MB に収める）
const AUDIO_BITS_PER_SECOND = 64_000;

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

/**
 * デスクトップの Chromium 系（Chrome/Edge）か。macOS Safari・Firefox・Android Chrome も
 * getDisplayMedia を持つが音声共有が取れない/スマホのため、ここで弾いてスマホ録音へ流す。
 */
function isDesktopChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|Mobile/.test(ua)) return false;
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; mobile?: boolean } })
    .userAgentData;
  if (uaData) {
    if (uaData.mobile) return false;
    return (uaData.brands ?? []).some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  }
  // Safari の UA には "Chrome/" が含まれない。iOS の Chrome/Edge は CriOS/EdgiOS。
  return /Chrome\/|Edg\//.test(ua) && !/Firefox|FxiOS|CriOS|EdgiOS/.test(ua);
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationSec: number;
}

/** 入力レベル（0〜1）。録音中に「本当に音が入っているか」を可視化するため（T7b）。 */
export interface AudioLevels {
  self: number;
  other: number;
}

export interface MeetingRecorder {
  recording: boolean;
  /** 一時停止中（MediaRecorder.pause。離席や別件の話題を録音から外す・T7b） */
  paused: boolean;
  /** 自分(マイク)/相手(システム音声)の入力レベル（約5回/秒で更新） */
  levels: AudioLevels;
  /** 相手側が無音のまま経過した秒数（共有の「システム音声」OFF 事故の早期検知） */
  otherSilentSec: number;
  error: string | null;
  /** getDisplayMedia が使えるか（デスクトップ Chromium のみ）。 */
  supported: boolean;
  /** 共有元（Zoom画面/タブ）が閉じられて録音が自動で確定した（停止ボタンで解析に進める）。 */
  shareEnded: boolean;
  mimeType: string;
  /** 録音を開始する。失敗時は ok=false と理由（画面側はこの戻り値を使う・stale closure 対策）。 */
  start: () => Promise<{ ok: boolean; error: string | null }>;
  stop: () => Promise<RecordingResult | null>;
  pause: () => void;
  resume: () => void;
}

/** AnalyserNode から RMS レベル（0〜1）を取る。 */
export function readLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  const rms = Math.sqrt(sum / buf.length);
  // 会話音声は RMS 0.01〜0.2 程度。0.15 で振り切る目盛りにする
  return Math.min(1, rms / 0.15);
}
/** これ未満は無音とみなす（RMS 換算 ≈ 0.003） */
export const SILENCE_LEVEL = 0.02;

export function useMeetingRecorder(): MeetingRecorder {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [levels, setLevels] = useState<AudioLevels>({ self: 0, other: 0 });
  const [otherSilentSec, setOtherSilentSec] = useState(0);
  const [shareEnded, setShareEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silentSinceRef = useRef<number | null>(null);

  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const displayRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>('audio/webm');
  // 共有終了などで先に録音が止まった時の確定済みデータ（stop() はこれを返す）
  const pendingRef = useRef<RecordingResult | null>(null);
  const stopWaitersRef = useRef<((r: RecordingResult | null) => void)[]>([]);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    !isIOS() &&
    isDesktopChromium();

  const cleanup = useCallback(() => {
    if (meterRef.current) clearInterval(meterRef.current);
    meterRef.current = null;
    displayRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    displayRef.current = null;
    micRef.current = null;
    ctxRef.current = null;
    mrRef.current = null;
  }, []);

  /** 収録済みチャンクから結果を確定する（一度だけ）。 */
  const finalize = useCallback((): RecordingResult | null => {
    if (pendingRef.current) return pendingRef.current;
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    const durationSec = Math.round((Date.now() - startedAtRef.current) / 1000);
    const result = blob.size > 0 ? { blob, mimeType: mimeRef.current, durationSec } : null;
    pendingRef.current = result;
    cleanup();
    setRecording(false);
    setPaused(false);
    return result;
  }, [cleanup]);

  // 画面遷移などでアンマウントされた時にマイク/画面共有を掴んだまま漏らさない。
  useEffect(() => {
    return () => {
      const mr = mrRef.current;
      if (mr && mr.state !== 'inactive') {
        try {
          mr.stop();
        } catch {
          /* ignore */
        }
      }
      cleanup();
    };
  }, [cleanup]);

  const start = useCallback(async (): Promise<{ ok: boolean; error: string | null }> => {
    setError(null);
    setShareEnded(false);
    pendingRef.current = null;
    if (!supported) {
      const msg = 'この機能はパソコンの Chrome / Edge でご利用ください（Safari・スマホは録音の音声共有に非対応）。';
      setError(msg);
      return { ok: false, error: msg };
    }
    try {
      // 共有ダイアログで「画面全体＋システム音声」または「タブ＋タブの音声」を選んでもらう（相手には何も見えない）。
      // systemAudio:'include' は Chrome 141+ で「システム音声を共有」を既定ONにするヒント（旧版は無視される）。
      // 選択ダイアログ自体はブラウザ仕様で省略できない。ヒントで「画面全体」タブを初期選択にし、
      // 「システム音声を共有」を既定ONにして、実質「録音を開始 → 共有」の2クリックにする。
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor' } as MediaTrackConstraints,
        audio: true,
        ...({
          systemAudio: 'include',
          // Chrome/Edge 152+ で「画面/ウィンドウ」ペインの音声チェックを既定ONにするヒント
          // （それ以前のバージョンや Safari/Firefox では無視される）。
          audioSelection: 'preferred',
          selfBrowserSurface: 'exclude',
          monitorTypeSurfaces: 'include',
          surfaceSwitching: 'exclude',
        } as Record<string, unknown>),
      } as DisplayMediaStreamOptions);
      displayRef.current = display;
      const sysAudio = display.getAudioTracks();
      if (sysAudio.length === 0) {
        cleanup();
        const msg =
          '相手の音声が取得できませんでした。共有ダイアログで「画面全体」を選び「システム音声を共有」をON（Zoomをブラウザで開いている場合はそのタブを選び「タブの音声も共有」をON）にしてください。';
        setError(msg);
        return { ok: false, error: msg };
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

      // レベルメーター（録音には影響しない分岐）。相手側が無音のまま続いたら UI で警告する。
      const micAn = ctx.createAnalyser();
      const sysAn = ctx.createAnalyser();
      micAn.fftSize = 1024;
      sysAn.fftSize = 1024;
      micSource.connect(micAn);
      sysSource.connect(sysAn);
      const buf = new Float32Array(1024) as Float32Array<ArrayBuffer>;
      silentSinceRef.current = Date.now();
      setOtherSilentSec(0);
      meterRef.current = setInterval(() => {
        if (mrRef.current?.state === 'paused') return;
        const self = readLevel(micAn, buf);
        const other = readLevel(sysAn, buf);
        setLevels({ self, other });
        if (other > SILENCE_LEVEL) {
          silentSinceRef.current = Date.now();
          setOtherSilentSec(0);
        } else if (silentSinceRef.current !== null) {
          setOtherSilentSec(Math.round((Date.now() - silentSinceRef.current) / 1000));
        }
      }, 200);

      const mimeType = pickMimeType() ?? 'audio/webm';
      mimeRef.current = mimeType;
      const mr = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      // onstop は start 時点で設定する（共有終了で先に止まっても Blob 化されるように）。
      mr.onstop = () => {
        const result = finalize();
        const waiters = stopWaitersRef.current;
        stopWaitersRef.current = [];
        waiters.forEach((w) => w(result));
      };
      // ユーザーがブラウザUIから共有を停止した／共有していたZoom画面・タブを閉じた場合:
      // 録音を確定して保持し、画面には「共有が終了した」ことを知らせる（停止ボタンで解析に進める）。
      sysAudio[0]!.addEventListener('ended', () => {
        setShareEnded(true);
        if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop();
      });
      mr.start(1000); // 1秒ごとにチャンク化（長時間でメモリを分割）
      mrRef.current = mr;
      startedAtRef.current = Date.now();
      setPaused(false);
      setRecording(true);
      return { ok: true, error: null };
    } catch (e) {
      cleanup();
      const name = e instanceof DOMException ? e.name : '';
      const raw = e instanceof Error ? e.message : String(e);
      let msg: string;
      if (name === 'NotAllowedError' || /Permission|denied|NotAllowed/i.test(raw)) {
        // ユーザーのキャンセルと、macOS の「画面収録」権限未許可の両方がここに来る
        msg =
          '画面共有が開始できませんでした。キャンセルした場合はもう一度お試しください。macOS で共有ダイアログに画面が出ない場合は「システム設定 › プライバシーとセキュリティ › 画面収録とシステムオーディオ録音」で Chrome を許可してください。';
      } else if (name === 'NotFoundError') {
        msg = 'マイクが見つかりませんでした。マイクを接続して再度お試しください。';
      } else {
        msg = raw;
      }
      setError(msg);
      return { ok: false, error: msg };
    }
  }, [supported, cleanup, finalize]);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    // 共有終了などで既に確定済みならそれを返す（1時間分を捨てない）
    if (pendingRef.current) return Promise.resolve(pendingRef.current);
    const mr = mrRef.current;
    if (!mr) return Promise.resolve(chunksRef.current.length ? finalize() : null);
    if (mr.state === 'inactive') return Promise.resolve(finalize());
    return new Promise((resolve) => {
      stopWaitersRef.current.push(resolve);
      mr.stop();
    });
  }, [finalize]);

  const pause = useCallback(() => {
    const mr = mrRef.current;
    if (mr && mr.state === 'recording') {
      mr.pause();
      setPaused(true);
    }
  }, []);
  const resume = useCallback(() => {
    const mr = mrRef.current;
    if (mr && mr.state === 'paused') {
      mr.resume();
      // 再開時は無音カウントもリセット（離席中の無音を警告に数えない）
      silentSinceRef.current = Date.now();
      setOtherSilentSec(0);
      setPaused(false);
    }
  }, []);

  return {
    recording,
    paused,
    levels,
    otherSilentSec,
    error,
    supported,
    shareEnded,
    mimeType: mimeRef.current,
    start,
    stop,
    pause,
    resume,
  };
}
