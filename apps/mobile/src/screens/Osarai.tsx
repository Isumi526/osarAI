// Osarai（AI対話おさらい：チャット）★コア — §8-1。
// 人と会ったあと、AIが1問ずつヒアリング→done で顧客カード(interactions/customers)へ自動反映。
// ?customerId=... 付きなら既存顧客のおさらい、無ければ新規（done 時に名前から自動でカード生成）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { osaraiTurn, transcribeAudio, type OsaraiTurnResponse } from '../lib/osarai.js';
import { updateInteractionSummary, getCustomer } from '../lib/db.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { useLiveSpeech } from '../hooks/useLiveSpeech.js';
import { MicIcon } from '../components/MicIcon.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';
import { ConfettiBurst } from '../components/ConfettiBurst.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import type { OsaraiExtracted } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };

// 初回メッセージが毎回同じ&そっけないという指摘(議事録要望)のため、顧客未指定/
// 顧客選択それぞれ複数パターン用意し、対話開始のたびにランダムに1つ選ぶ。
const OPENINGS_NEW = [
  '今日はどんな方と会いましたか？どんな話をしたか、覚えていることを教えてください。',
  'おつかれさまです！今日会った方のこと、思い出しながら聞かせてください。',
  '今日はどんな出会いがありましたか？印象に残っていることから話してもらえますか？',
];
// つながりAI登録（新規カードを対話だけで作る導線・CustomerForm.tsx参照）専用の開始メッセージ。
// 想定利用者は「既に関係性がある人・何度か話したことがある人」(CustomerForm.tsxの案内文言と同じ前提)
// であり、赤の他人と初めて会った体では聞かない。「はじめまして」「新しく出会った方」トーンはNG指摘。
const OPENINGS_REGISTER = [
  'つながりを登録しましょう。どんな方ですか？関係性や、知っていることから教えてください。',
  'あの方について教えてください。どんな関係の方で、これまでどんなやり取りがありましたか？',
  'AIが聞きながら整理します。どんな方か、関係性や知っていることを聞かせてください。',
];
const pickRandom = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!;
const OPENING_NEW = () => pickRandom(OPENINGS_NEW);
const OPENING_REGISTER = () => pickRandom(OPENINGS_REGISTER);
const openingForExisting = (name: string) =>
  pickRandom([
    `${name}さんとの話、振り返ってみましょう。今日はどんな話をしましたか？`,
    `${name}さんとお会いしたんですね。どんな話をしたか教えてください。`,
    `${name}さんとの時間、おつかれさまでした。印象に残っていることはありますか？`,
  ]);
// つながりAI登録で名前が判明した後の開始メッセージ。「初めて聞く」ではなく、
// 既に予定等で関わりがある相手についてこれまでの関係性・話した内容・知っていることを
// 聞く内容にする(議事録指摘: 全くの初対面向けの文言はおかしい)。
const openingForRegister = (name: string) =>
  pickRandom([
    `${name}さんについて登録しましょう。これまでどんな話をしましたか？関係性や知っていることも教えてください。`,
    `${name}さんはどんな方ですか？今までのやり取りや、知っていることを聞かせてください。`,
    `${name}さんとのこれまでを教えてください。話した内容や関係性、知っていることがあれば聞かせてください。`,
  ]);
// APIの仮名フォールバックはプリフィルせず空にし、必須入力を促す
const prefillName = (isNew: boolean, name: string | null) =>
  isNew && name && name !== '新しく会った人' ? name : '';
// 既存顧客の名前が空/仮名のままかどうか（判明した名前の自動反映に使う）
const isPlaceholderCustomerName = (name: string | null) => !name || !name.trim() || name === '新しく会った人';

// 相手について自由に話すきっかけになるヒント(バブルUI)。タップするとその話題で話し始められる。
const HINTS: { label: string; message: string }[] = [
  { label: '最近の様子について話す', message: '最近の様子について話したいです。' },
  { label: '困りごとや気になっていることについて話す', message: '困りごとや気になっていることについて話したいです。' },
  { label: '次回の約束・アクションについて話す', message: '次回の約束やアクションについて話したいです。' },
];

// 配列⇔複数行テキストの相互変換（サマリ編集フォーム用）
const toLines = (v?: string[]) => (v ?? []).join('\n');
const fromLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

export function Osarai() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customerId = params.get('customerId');
  // つながりAI登録（CustomerForm.tsx/予定の登録提案モーダルの「AIと対話して登録する」）専用モード。
  // customerIdの有無に関わらずmode=registerなら登録目的の文言にする
  // (予定作成中にその場で名前だけ仮登録したつながりを、そのままAI対話で本登録する導線もcustomerIdを持つため)。
  const isRegisterMode = params.get('mode') === 'register';

  const [messages, setMessages] = useState<Msg[]>([
    { role: 'assistant', content: isRegisterMode ? OPENING_REGISTER() : OPENING_NEW() },
  ]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [savedCustomerId, setSavedCustomerId] = useState<string | null>(null);
  const [savedInteractionId, setSavedInteractionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const lastAudioRef = useRef<Blob | null>(null);
  // AIが考え中でも続けて送信でき、受け取った順に1件ずつ処理する(AiChat.tsxのキュー方式を移植)。
  const [queue, setQueue] = useState<string[]>([]);
  const processingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // サマリ確認・修正フォーム（F-02 AC: 生成されたサマリをユーザーが確認・修正できる）
  const [editPoints, setEditPoints] = useState('');
  const [editNeeds, setEditNeeds] = useState('');
  const [editNextActions, setEditNextActions] = useState('');
  const [editName, setEditName] = useState('');
  const [isNewCustomer, setIsNewCustomer] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 既存顧客(customerId指定)の対話開始時点の名前。空/仮名のままなら、判明した名前を自動反映する対象にする。
  const [existingCustomerName, setExistingCustomerName] = useState<string | null>(null);
  const [autoNamePrefill, setAutoNamePrefill] = useState(false);
  const recorder = useRecorder();
  const liveSpeech = useLiveSpeech();
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  // ← 戻るボタンの確認条件(未保存の対話中)と同じ基準で、下部ナビタップ時も確認を挟む。
  useRegisterNavGuard(!done && messages.length > 1);

  // 時間指定の深掘りセッション（既定5分・延長可）。最初の発話が送られてから計測開始。
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, done]);

  useEffect(() => {
    if (remainingSec === null || done) return;
    if (remainingSec <= 0) return;
    const t = setInterval(() => setRemainingSec((s) => (s === null ? null : Math.max(0, s - 1))), 1000);
    return () => clearInterval(t);
  }, [remainingSec === null, done]);

  function formatMMSS(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // 「続けておさらいする」: 完了状態から次の対話へ、状態を初期化して再開する。
  function startNewSession() {
    setMessages([{ role: 'assistant', content: OPENING_NEW() }]);
    setInput('');
    setSessionId(undefined);
    setDone(false);
    setSavedCustomerId(null);
    setSavedInteractionId(null);
    setError(null);
    setEditPoints('');
    setEditNeeds('');
    setEditNextActions('');
    setEditName('');
    setIsNewCustomer(false);
    setAutoNamePrefill(false);
    setExistingCustomerName(null);
    setConfirmed(false);
    setConfirming(false);
    setRemainingSec(null);
    setEnding(false);
    setQueue([]);
    navigate('/osarai');
  }

  async function onBack() {
    if (!done && messages.length > 1) {
      const ok = await confirm(
        'ここまでの内容はまだ保存されていません。\n「ここまでで終える」で保存してから戻ることをおすすめします。\nこのまま戻りますか？（内容は失われます）',
      );
      if (!ok) return;
    }
    navigate(-1);
  }

  // 既存顧客のおさらいなら、初回の質問を顧客名入りの文言に差し替える（新規は既定文言のまま）。
  // 現在の名前も控えておき、まだ空/仮名なら対話で判明した名前を自動反映する対象にする（F-02 名前自動反映）。
  // registerMode(つながりAI登録)はcustomerIdがあっても「初対面として登録する」目的ではなく、
  // 予定等で既に関わりがある相手の関係性・これまでの話を聞く目的のため、専用の名前入りオープニングに
  // 差し替える（全くの初対面向け文言はおかしいというNG指摘）。
  useEffect(() => {
    if (!customerId) return;
    getCustomer(customerId)
      .then((c) => {
        if (!c) return;
        setExistingCustomerName(c.name ?? null);
        if (c.name) {
          setMessages([
            { role: 'assistant', content: isRegisterMode ? openingForRegister(c.name) : openingForExisting(c.name) },
          ]);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, isRegisterMode]);

  // 文字起こしを実行（録音blobを保持し、失敗時は再試行できるようにする）
  async function runTranscribe(blob: Blob) {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const text = await transcribeAudio(blob);
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      lastAudioRef.current = null;
    } catch {
      // 生の(英語)エラーをそのまま出さず、再試行を促す日本語メッセージにする。録音は保持。
      lastAudioRef.current = blob;
      setTranscribeError('文字起こしに失敗しました。通信状況を確認して、もう一度お試しください。');
    } finally {
      setTranscribing(false);
    }
  }

  // マイク: 録音中なら停止→文字起こし→入力欄へ、そうでなければ録音開始
  async function toggleMic() {
    if (sending || transcribing || done) return;
    setError(null);
    setTranscribeError(null);
    if (recorder.recording) {
      liveSpeech.stop(); // 確定はサーバーSTTが行うため、プレビュー用の認識はここで破棄
      const blob = await recorder.stop();
      if (!blob) return;
      await runTranscribe(blob);
    } else {
      await recorder.start();
      if (recorder.error) {
        setError(recorder.error);
        return;
      }
      liveSpeech.start(); // 非対応ブラウザではsupported=falseのため何も起きず、従来どおりのフローになる
    }
  }

  // done時の共通処理: サマリ編集フォームへ反映する。既存顧客で名前が空/仮名のままなら、
  // 対話で判明した名前(extracted.name)を検出してプリフィルする（F-02 名前自動反映・上書きはしない）。
  function applyDoneCard(res: OsaraiTurnResponse) {
    setSavedCustomerId(res.customerId);
    setSavedInteractionId(res.interactionId);
    setIsNewCustomer(res.isNewCustomer);
    const ext: OsaraiExtracted = res.extracted ?? {};
    const detectedName = typeof ext.name === 'string' ? ext.name.trim() : '';
    const autoName = !res.isNewCustomer && !!detectedName && isPlaceholderCustomerName(existingCustomerName);
    setAutoNamePrefill(autoName);
    setEditName(prefillName(res.isNewCustomer, res.customerName) || (autoName ? detectedName : ''));
    setEditPoints(toLines(ext.points));
    setEditNeeds(toLines(ext.needs));
    setEditNextActions(toLines(ext.next_actions));
  }

  // 送信: 生成中でも受け付け、ユーザー発話を即表示してキューに積む(逐次ワーカーが処理)。
  function sendMessage(text: string) {
    const t = text.trim();
    if (!t || done) return;
    setError(null);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: t }]);
    setQueue((q) => [...q, t]);
  }

  // キューを1件ずつ順番に処理するワーカー。sessionId更新→再評価で次の1件へ進む。
  // processingRefで多重起動を防ぐ(処理中のsessionId/customerId変化は無視)。done後はキューを止める。
  useEffect(() => {
    if (processingRef.current || queue.length === 0 || done) return;
    processingRef.current = true;
    const text = queue[0]!;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    osaraiTurn({ message: text, sessionId, customerId }, controller.signal)
      .then((res) => {
        setSessionId(res.sessionId);
        setRemainingSec((s) => (s === null ? 300 : s)); // 最初の送信でタイマー開始（既定5分）
        if (res.next_question) {
          setMessages((m) => [...m, { role: 'assistant', content: res.next_question! }]);
        }
        if (res.done) {
          setDone(true);
          applyDoneCard(res);
          // done後は残りの未処理キュー(もしあれば)は破棄する。返答されないまま残さないため。
          setQueue([]);
        } else {
          setQueue((q) => q.slice(1));
        }
      })
      .catch((e) => {
        // 停止(abort)はエラー表示しない。停止/エラーともキューを破棄し中断する。
        if (!controller.signal.aborted) {
          setError(String(e instanceof Error ? e.message : e));
        }
        setQueue([]);
      })
      .finally(() => {
        abortRef.current = null;
        setSending(false);
        processingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, sessionId, customerId, done]);

  // 生成中の停止: 進行中リクエストをabortし、未処理のキューも破棄する。
  function stopGenerating() {
    abortRef.current?.abort();
    setQueue([]);
  }

  function send() {
    sendMessage(input);
  }

  // 明示的な終了（達成感UI）: ここまでの内容で強制的にdone扱いにして保存。
  // キューが残っている間(まだ処理中の発話がある間)は、途中の履歴で終えてしまわないよう待つ。
  async function endEarly() {
    if (!sessionId || sending || done || ending || queue.length > 0) return;
    setError(null);
    setEnding(true);
    try {
      const res = await osaraiTurn({ message: '', sessionId, customerId, forceEnd: true });
      setDone(true);
      applyDoneCard(res);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setEnding(false);
    }
  }

  async function onConfirmSummary() {
    if (!savedInteractionId || !savedCustomerId) return;
    // 新規顧客の場合は名前を必須にする（「新しく会った人」の仮名放置を防ぐ・見分けがつかなくなるため）
    if (isNewCustomer && !editName.trim()) {
      setError('お名前を入力してください（あとで見分けがつかなくなるため）。');
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      await updateInteractionSummary(savedInteractionId, savedCustomerId, {
        points: fromLines(editPoints),
        needs: fromLines(editNeeds),
        next_actions: fromLines(editNextActions),
        ...(isNewCustomer || autoNamePrefill ? { name: editName.trim() } : {}),
      });
      setConfirmed(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setConfirming(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Cmd/Ctrl+Enter のみ送信。Enter単独・Shift+Enterは改行（誤送信防止のため送信トリガーから除外）。
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  }

  // 送信フォームをposition:fixedで画面下部に固定する(議事録要望)。ヘッダー固定化
  // (ScreenHeader)と同じ「実高さを測ってpadding-bottomに反映する」方針を踏襲し、
  // ハードコードした高さ決め打ちによる重なり不具合の再発を避ける。
  const formRef = useRef<HTMLDivElement>(null);
  const [formHeight, setFormHeight] = useState(0);
  useLayoutEffect(() => {
    const el = formRef.current;
    if (!el || done) return;
    const apply = () => setFormHeight(el.offsetHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [done]);

  return (
    <main
      className="screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 'calc(100dvh - 56px)',
        // 送信フォームがposition:fixedで画面下部に重なるため、ページ末尾のコンテンツが
        // 隠れないよう実測したフォーム高さ分の余白を追加する(.screenの既定paddingBottomを上書き)。
        ...(done ? {} : { paddingBottom: 24 + BOTTOM_NAV_HEIGHT + formHeight }),
      }}
    >
      <ScreenHeader>
        <button onClick={onBack} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-primary)' }}>← 戻る</button>
        <strong>{isRegisterMode ? 'つながりを登録しましょう' : 'おさらい'}</strong>
        {remainingSec !== null && !done ? (
          remainingSec === 0 ? (
            <button
              type="button"
              onClick={() => setRemainingSec(300)}
              style={{ padding: '4px 8px', fontSize: 13, whiteSpace: 'nowrap' }}
            >
              +5分延長
            </button>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{formatMMSS(remainingSec)}</span>
          )
        ) : (
          <span style={{ width: 48 }} />
        )}
      </ScreenHeader>

      {/* 対話。ScreenHeaderがposition:fixedのためheaderは通常フローから外れる。
          .screenのpadding-topが--header-height(ScreenHeaderが実測してCSS変数に反映)に
          追従するため、ここで別途余白を積み増す必要はない。 */}
      <div style={{ flex: 1, display: 'grid', gap: 10, marginTop: 12, padding: '0 0 12px', alignContent: 'start' }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '80%',
              background: m.role === 'user' ? '#fd780f' : '#fff',
              color: m.role === 'user' ? '#fff' : 'inherit',
              border: m.role === 'user' ? 'none' : '1px solid var(--color-border)',
              borderRadius: 14,
              padding: '10px 14px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            {m.content}
          </div>
        ))}
        {recorder.recording && liveSpeech.supported && (
          <div
            style={{
              justifySelf: 'end',
              maxWidth: '85%',
              background: '#fd780f',
              opacity: 0.6,
              color: '#fff',
              borderRadius: 14,
              padding: '10px 14px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}
          >
            {liveSpeech.interimText || '（話した内容がここに表示されます…）'}
          </div>
        )}
        {sending && (
          <div style={{ justifySelf: 'start', color: '#9a9183', fontSize: 13 }}>AIが考えています…</div>
        )}
        {transcribing && (
          <div style={{ justifySelf: 'end', color: '#9a9183', fontSize: 13 }}>文字起こし中…（少し時間がかかる場合があります）</div>
        )}
        {transcribeError && (
          <div style={{ justifySelf: 'end', textAlign: 'right' }}>
            <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{transcribeError}</div>
            {lastAudioRef.current && (
              <button
                type="button"
                onClick={() => lastAudioRef.current && runTranscribe(lastAudioRef.current)}
                disabled={transcribing}
                style={{ marginTop: 4, padding: '4px 12px', fontSize: 13 }}
              >
                もう一度文字起こし
              </button>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {/* 完了: サマリ確認・修正 → 保存確認（F-02 AC） */}
      {done ? (
        confirmed ? (
          <section
            style={{
              position: 'relative',
              background: 'var(--color-primary-light)',
              border: '1px solid var(--color-primary-border)',
              borderRadius: 16,
              padding: '32px 20px',
              textAlign: 'center',
            }}
          >
            <ConfettiBurst />
            <svg width="56" height="56" viewBox="0 0 56 56" style={{ margin: '0 auto 16px' }} aria-hidden="true">
              <circle cx="28" cy="28" r="28" fill="var(--color-primary)" />
              <path
                d="M17 29l7 7 15-15"
                fill="none"
                stroke="#fff"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700 }}>おさらいが完了しました</p>
            <p style={{ margin: '0 0 24px', color: 'var(--color-text-muted)', fontSize: 14 }}>
              つながりカードに整理しました。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={startNewSession} style={{ flex: 1, padding: 12 }}>
                続けておさらいする
              </button>
              <button onClick={() => navigate('/')} style={{ flex: 1, padding: 12 }}>
                ホームに戻る
              </button>
            </div>
            {savedCustomerId && (
              <button
                onClick={() => navigate(`/customers/${savedCustomerId}`)}
                style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--color-primary)', padding: 0 }}
              >
                カードを見る
              </button>
            )}
          </section>
        ) : (
          <section
            style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, padding: 16 }}
          >
            <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
              AIが整理しました。内容を確認・修正してください。
            </p>

            {(isNewCustomer || autoNamePrefill) && (
              <label style={{ display: 'block', marginBottom: 10 }}>
                お名前{isNewCustomer ? '（必須）' : '（対話から自動検出。違っていれば修正してください）'}
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例: 田中太郎"
                  style={{ width: '100%', padding: 10, fontSize: 16, marginTop: 4 }}
                />
              </label>
            )}

            <label style={{ display: 'block', marginBottom: 10 }}>
              要点（1行に1つ）
              <AutoResizeTextarea
                value={editPoints}
                onChange={(e) => setEditPoints(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 10 }}>
              ニーズ（1行に1つ）
              <AutoResizeTextarea
                value={editNeeds}
                onChange={(e) => setEditNeeds(e.target.value)}
                rows={2}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 12 }}>
              次アクション（1行に1つ）
              <AutoResizeTextarea
                value={editNextActions}
                onChange={(e) => setEditNextActions(e.target.value)}
                rows={2}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>

            <button
              onClick={onConfirmSummary}
              disabled={confirming}
              style={{ width: '100%', padding: 12, fontSize: 16 }}
            >
              {confirming ? '保存中…' : 'この内容で保存'}
            </button>
          </section>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
          <div style={{ position: 'relative', alignSelf: 'flex-start' }}>
            <button
              type="button"
              onClick={() => setShowHint((v) => !v)}
              aria-label="ヒントを見る"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                height: 28,
                minHeight: 28,
                padding: '0 10px',
                borderRadius: 14,
                background: 'var(--color-primary-light)',
                color: 'var(--color-primary)',
                border: '1px solid var(--color-primary-border)',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" />
                <circle cx="12" cy="17" r="0.5" fill="currentColor" />
              </svg>
              ヒント
            </button>
            {showHint && (
              <div
                style={{
                  position: 'absolute',
                  bottom: '120%',
                  left: 0,
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 12,
                  padding: 12,
                  width: 240,
                  fontSize: 13,
                  color: 'var(--color-text)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                  zIndex: 10,
                }}
              >
                思い出したことをそのままの言葉で話してくれるだけでOKです。AIが掘り下げて整理します。
              </div>
            )}
          </div>
          {/* まだ話し始めていない時だけヒント(バブル)を出す。タップでその話題から始める。 */}
          {messages.length === 1 && !sending && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {HINTS.map((h) => (
                <button
                  key={h.label}
                  type="button"
                  onClick={() => sendMessage(h.message)}
                  style={{
                    padding: '8px 14px',
                    background: 'var(--color-primary-light)',
                    border: '1px solid var(--color-primary-border)',
                    borderRadius: 999,
                    color: 'var(--color-primary)',
                    fontSize: 13,
                  }}
                >
                  {h.label}
                </button>
              ))}
            </div>
          )}
          {sessionId && (
            <button
              type="button"
              onClick={endEarly}
              disabled={ending || sending || queue.length > 0}
              style={{
                alignSelf: 'flex-end',
                background: 'none',
                border: 'none',
                padding: '4px 0',
                color: 'var(--color-text-muted)',
                fontSize: 13,
                textDecoration: 'underline',
              }}
            >
              {ending ? '保存中…' : 'ここまでで終える'}
            </button>
          )}
          <div
            ref={formRef}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
              position: 'fixed',
              left: 0,
              right: 0,
              // BottomNav(position:fixed・bottom:0・zIndex:100)と重ならないよう、その上に乗せる。
              bottom: BOTTOM_NAV_HEIGHT,
              maxWidth: 640,
              margin: '0 auto',
              background: 'var(--color-bg)',
              padding: '8px 20px',
              borderTop: '1px solid var(--color-border)',
              zIndex: 50,
            }}
          >
          {recorder.supported && (
            <button
              onClick={toggleMic}
              disabled={sending || transcribing}
              aria-label={recorder.recording ? '録音を止める' : '音声で話す'}
              style={{
                padding: '0 16px',
                minHeight: 44,
                background: recorder.recording ? '#c0392b' : '#fff',
                color: recorder.recording ? '#fff' : 'inherit',
                border: '1px solid var(--color-border)',
                borderRadius: 10,
              }}
            >
              {recorder.recording ? (
                <>
                  <MicIcon recording /> 停止
                </>
              ) : (
                <MicIcon recording={false} />
              )}
            </button>
          )}
          <AutoResizeTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={recorder.recording ? '録音中…話し終えたら停止' : '話したことを入力…'}
            rows={1}
            disabled={recorder.recording}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--color-border)',
              resize: 'none',
              fontFamily: 'inherit',
              fontSize: 15,
            }}
          />
          {/* 生成中でも送信ボタンは有効(キューに積める)。生成中は停止ボタンも並べる。 */}
          {sending && (
            <button
              onClick={stopGenerating}
              aria-label="生成を停止"
              style={{ padding: '0 14px', minHeight: 44, background: 'var(--color-text-muted)' }}
            >
              ■
            </button>
          )}
          <button
            onClick={send}
            disabled={transcribing || !input.trim()}
            style={{ padding: '0 18px', minHeight: 44 }}
          >
            送信
          </button>
          </div>
        </div>
      )}
      {confirmDialog}
    </main>
  );
}
