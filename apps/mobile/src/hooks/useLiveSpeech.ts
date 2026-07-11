// 音声入力中のリアルタイム認識プレビュー（§8-1 音声入力・議事録『review』要望）。
// ブラウザのWeb Speech API(SpeechRecognition)による認識中テキスト表示のみを担う。
// 実際にtextareaへ確定する文字起こしは従来どおりuseRecorder+サーバーSTT(Gemini)が行う
// (AC②: 確定後は従来通りtextareaに入る)。非対応ブラウザ(iOS Safari/多くのWebView等)では
// supported=falseとなり、呼び出し側は何もせず従来のフロー(録音→一括STT)のみになる。
import { useCallback, useRef, useState } from 'react';

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export interface LiveSpeech {
  supported: boolean;
  interimText: string;
  start: () => void;
  stop: () => void;
}

export function useLiveSpeech(): LiveSpeech {
  const Ctor = getSpeechRecognitionCtor();
  const [interimText, setInterimText] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  const start = useCallback(() => {
    if (!Ctor) return;
    setInterimText('');
    try {
      const rec = new Ctor();
      rec.lang = 'ja-JP';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        // バグ修正: e.resultIndexから連結すると、そのイベントで新規に追加された
        // 区間しか表示されず、既に確定済み(isFinal)の前半部分が表示から消えてしまい
        // 実際の(全区間を対象にサーバーSTTする)確定後の文字起こし結果と食い違っていた。
        // 常に0番目から全区間を連結し、これまで話した内容の累積を表示する。
        let text = '';
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i]?.[0]?.transcript ?? '';
        }
        setInterimText(text);
      };
      rec.onerror = () => {
        // 認識エラーはプレビュー表示のみの機能なので静かに諦める(確定はサーバーSTTが担う)
      };
      rec.onend = () => {
        recRef.current = null;
      };
      rec.start();
      recRef.current = rec;
    } catch {
      // 開始失敗時もプレビューを諦めるだけ(録音自体には影響しない)
    }
  }, [Ctor]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setInterimText('');
  }, []);

  return { supported: Boolean(Ctor), interimText, start, stop };
}
