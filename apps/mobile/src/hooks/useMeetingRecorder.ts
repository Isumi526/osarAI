// PC透明ローカル録音フック（T1）。getDisplayMedia で画面/タブのシステム音声（相手）を、
// getUserMedia でマイク（自分）を取得する。会議にボットは入れず、相手には録音が一切見えない（透明）。
//
// 2026-09-22: ステレオ1本（左=自分/右=相手）を止め、マイクとシステム音声を「別々の2ファイル」
//   として録音するように変更した。Gemini はチャンネルを見ておらず、役割から話者を推測するため、
//   本人が無言でも相手の発言を「自分」と誤認していた（人レビューで発覚）。Notta と同じく
//   トラックを物理的に分けて別々に文字起こしすれば、話者の取り違えは原理的に起きない。
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
  /** 相手（システム音声）のトラック。会議の主たる音声。 */
  blob: Blob;
  /** 自分（マイク・ゲート後）のトラック。本人がほぼ無言なら null（送らない＝誤認も費用も無し）。 */
  selfBlob: Blob | null;
  mimeType: string;
  durationSec: number;
  /**
   * 録音者本人（マイク）が実際に話していた時間帯 [開始秒, 終了秒]（T7c）。
   * スピーカー再生だと相手の声がマイクにも漏れて「自分の発言」と誤認されるため、
   * マイク側は「相手より十分大きい時だけ通す」ゲートをかけ、通した区間を記録して文字起こしのヒントにする。
   */
  selfSegments?: [number, number][];
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
  /** 録音を開始する。onChunk は timeslice ごとの Blob（IndexedDB への逐次保存用・T7c）。track でどちらの音声かを区別する。 */
  start: (opts?: { onChunk?: (blob: Blob, index: number, track: 'other' | 'self') => void }) => Promise<{ ok: boolean; error: string | null }>;
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
/** マイク側でこの秒数も話していなければ「本人は発言していない」とみなし、自分トラックを送らない。 */
export const SELF_SPEECH_MIN_SEC = 1;

export function useMeetingRecorder(): MeetingRecorder {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [levels, setLevels] = useState<AudioLevels>({ self: 0, other: 0 });
  const [otherSilentSec, setOtherSilentSec] = useState(0);
  const [shareEnded, setShareEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silentSinceRef = useRef<number | null>(null);

  // 相手（システム音声）／自分（マイク）を別々の MediaRecorder で録る
  const mrRef = useRef<MediaRecorder | null>(null);
  const mrSelfRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const selfChunksRef = useRef<Blob[]>([]);
  const displayRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>('audio/webm');
  // 共有終了などで先に録音が止まった時の確定済みデータ（stop() はこれを返す）
  const pendingRef = useRef<RecordingResult | null>(null);
  // 本人が話していた区間（ゲート通過区間・録音開始からの秒）。finalize で RecordingResult に載せる
  const selfSegmentsRef = useRef<[number, number][]>([]);
  const selfOpenRef = useRef<number | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
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
    try {
      processorRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    processorRef.current = null;
    displayRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    displayRef.current = null;
    micRef.current = null;
    ctxRef.current = null;
    mrRef.current = null;
    mrSelfRef.current = null;
  }, []);

  /** 収録済みチャンクから結果を確定する（一度だけ）。 */
  const finalize = useCallback((): RecordingResult | null => {
    if (pendingRef.current) return pendingRef.current;
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    const durationSec = Math.round((Date.now() - startedAtRef.current) / 1000);
    if (selfOpenRef.current !== null) {
      selfSegmentsRef.current.push([selfOpenRef.current, durationSec]);
      selfOpenRef.current = null;
    }
    // 本人がほとんど話していない録音では、マイク側は送らない。
    // （送ると「漏れ込んだ相手の声」を自分の発言として文字起こししてしまう）
    const selfSpokenSec = selfSegmentsRef.current.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
    const selfRaw = new Blob(selfChunksRef.current, { type: mimeRef.current });
    const selfBlob = selfSpokenSec >= SELF_SPEECH_MIN_SEC && selfRaw.size > 0 ? selfRaw : null;
    const result = blob.size > 0 ? { blob, selfBlob, mimeType: mimeRef.current, durationSec, selfSegments: selfSegmentsRef.current } : null;
    pendingRef.current = result;
    cleanup();
    setRecording(false);
    setPaused(false);
    return result;
  }, [cleanup]);

  // 画面遷移などでアンマウントされた時にマイク/画面共有を掴んだまま漏らさない。
  useEffect(() => {
    return () => {
      for (const mr of [mrRef.current, mrSelfRef.current]) {
        if (mr && mr.state !== 'inactive') {
          try {
            mr.stop();
          } catch {
            /* ignore */
          }
        }
      }
      cleanup();
    };
  }, [cleanup]);

  const start = useCallback(async (startOpts?: { onChunk?: (blob: Blob, index: number, track: 'other' | 'self') => void }): Promise<{ ok: boolean; error: string | null }> => {
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

      // スピーカー再生時に相手の声がマイクへ回り込む分は、まずブラウザのエコーキャンセルに消させる。
      // （ゲートで強く削ると、イヤホンを外した時に本人の声まで落ちる。2026-09-22 の実機レビューで発覚）
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micRef.current = mic;

      // WebAudio で 自分(マイク・ゲート後) と 相手(システム音声) を「別々の出力」に分ける。
      // 1本のステレオにまとめると、文字起こし側がチャンネルを見ないため話者を取り違える。
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const micSource = ctx.createMediaStreamSource(mic);
      const sysSource = ctx.createMediaStreamSource(new MediaStream(sysAudio));
      // マイクは「常にそのまま録る」（本人の声を絶対に落とさない）。
      // ここでは本人が話していた区間だけを記録し、後段のヒントに使う。相手の声の回り込みは
      // ①エコーキャンセル ②サーバー側で相手トラックと重複する発話を落とす、の2段で処理する。
      // ScriptProcessorNode は非推奨だが、外部ファイル不要で全ブラウザで動くためここでは採用。
      const gate = ctx.createScriptProcessor(2048, 2, 1);
      const pair = ctx.createChannelMerger(2);
      micSource.connect(pair, 0, 0);
      sysSource.connect(pair, 0, 1);
      pair.connect(gate);
      selfSegmentsRef.current = [];
      selfOpenRef.current = null;
      let holdBlocks = 0;
      const gateStart = ctx.currentTime;
      gate.onaudioprocess = (ev) => {
        const micIn = ev.inputBuffer.getChannelData(0);
        const sysIn = ev.inputBuffer.getChannelData(1);
        const out = ev.outputBuffer.getChannelData(0);
        let m = 0;
        let sy = 0;
        for (let i = 0; i < micIn.length; i++) {
          m += micIn[i]! * micIn[i]!;
          sy += sysIn[i]! * sysIn[i]!;
        }
        const micRms = Math.sqrt(m / micIn.length);
        const sysRms = Math.sqrt(sy / sysIn.length);
        // 本人が話している判定（録音は止めない・区間の記録だけに使う）。
        // 相手より十分小さい入力は回り込みとみなして「発言」には数えない。
        const speaking = micRms > 0.01 && micRms > sysRms * 0.6;
        if (speaking) holdBlocks = 8; // 語尾が切れないよう約0.4秒ホールド
        else if (holdBlocks > 0) holdBlocks--;
        const speakingNow = speaking || holdBlocks > 0;
        const t = Math.max(0, Math.round(ev.playbackTime - gateStart));
        if (speakingNow && selfOpenRef.current === null) selfOpenRef.current = t;
        if (!speakingNow && selfOpenRef.current !== null) {
          if (t - selfOpenRef.current >= 1) selfSegmentsRef.current.push([selfOpenRef.current, t]);
          selfOpenRef.current = null;
        }
        out.set(micIn); // マイクは常にそのまま通す
      };
      processorRef.current = gate;
      const otherDest = ctx.createMediaStreamDestination();
      const selfDest = ctx.createMediaStreamDestination();
      sysSource.connect(otherDest);
      gate.connect(selfDest);

      // レベルメーター（録音には影響しない分岐）。相手側が無音のまま続いたら UI で警告する。
      const micAn = ctx.createAnalyser();
      const sysAn = ctx.createAnalyser();
      micAn.fftSize = 1024;
      sysAn.fftSize = 1024;
      micSource.connect(micAn); // 生のマイク＝話せば必ず振れる
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
      chunksRef.current = [];
      selfChunksRef.current = [];
      const mkRecorder = (stream: MediaStream, track: 'other' | 'self', sink: Blob[]): MediaRecorder => {
        const r = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
        let index = 0;
        r.ondataavailable = (e) => {
          if (e.data.size > 0) {
            sink.push(e.data);
            try {
              startOpts?.onChunk?.(e.data, index++, track);
            } catch {
              /* 保存失敗で録音は止めない */
            }
          }
        };
        return r;
      };
      const mr = mkRecorder(otherDest.stream, 'other', chunksRef.current);
      const mrSelf = mkRecorder(selfDest.stream, 'self', selfChunksRef.current);
      // onstop は start 時点で設定する（共有終了で先に止まっても Blob 化されるように）。
      // 相手側の onstop で確定するが、自分側が止まりきるのを待ってから Blob 化する。
      mr.onstop = () => {
        const done = () => {
          const result = finalize();
          const waiters = stopWaitersRef.current;
          stopWaitersRef.current = [];
          waiters.forEach((w) => w(result));
        };
        if (mrSelf.state !== 'inactive') {
          mrSelf.addEventListener('stop', done, { once: true });
          try {
            mrSelf.stop();
          } catch {
            done();
          }
        } else done();
      };
      // ユーザーがブラウザUIから共有を停止した／共有していたZoom画面・タブを閉じた場合:
      // 録音を確定して保持し、画面には「共有が終了した」ことを知らせる（停止ボタンで解析に進める）。
      sysAudio[0]!.addEventListener('ended', () => {
        setShareEnded(true);
        if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop();
      });
      mr.start(1000); // 1秒ごとにチャンク化（長時間でメモリを分割）
      mrSelf.start(1000);
      mrRef.current = mr;
      mrSelfRef.current = mrSelf;
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
      if (mrSelfRef.current?.state === 'recording') mrSelfRef.current.pause(); // 2トラックを揃えて止める
      setPaused(true);
    }
  }, []);
  const resume = useCallback(() => {
    const mr = mrRef.current;
    if (mr && mr.state === 'paused') {
      mr.resume();
      if (mrSelfRef.current?.state === 'paused') mrSelfRef.current.resume();
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
