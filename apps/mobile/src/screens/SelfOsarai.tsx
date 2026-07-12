// 自分をおさらいする（既存の顧客向けおさらいとは別・AI対話で自分自身を深掘り）。
// 何度でも実行可能。抽出結果(notes)はprofiles.user_profileに蓄積され、AI戦略相談の
// コンテキストに含まれる。低優先度機能のためテキストのみ(音声入力なし)の軽量実装。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { selfOsaraiTurn } from '../lib/selfOsarai.js';
import { saveSelfOsaraiExtraction } from '../lib/db.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';

type Msg = { role: 'user' | 'assistant'; content: string };

// フォーム的に順番に聞くのをやめ、自由に話せる開始メッセージにする(回答C)。
// 名前はアカウント作成時に登録済みなので聞かない。未登録項目はAIが会話の中で自然に深掘りする。
const DEFAULT_OPENING =
  'こんにちは。あなた自身のこと、なんでも自由に話してください。下のヒントから選んで話し始めてもOKです。';

// 自由入力のきっかけになるヒント(バブルUI)。タップするとその話題で話し始められる。
const HINTS: { label: string; message: string }[] = [
  { label: '自分の仕事について話す', message: '自分の仕事について話したいです。' },
  { label: '扱っている商品について話す', message: '扱っている商品について話したいです。' },
  { label: '今後の夢や目標について話す', message: '今後の夢や目標について話したいです。' },
];

export function SelfOsarai() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // ウェルカム画面経由の初回セッションでは下部固定ナビを非表示にする(離脱防止・BottomNav.tsx
  // のuseBottomNavVisible()と対応)。その分、画面の高さもフルに使う。
  const fromWelcome = params.get('from') === 'welcome';
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: DEFAULT_OPENING }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AIが考え中でも続けて送信でき、受け取った順に1件ずつ処理する(AiChat.tsxのキュー方式を移植)。
  // 送信済みの会話は historyRef に確定順で積み、次のリクエストはこれを履歴として使う
  // (messagesはキュー中の未処理ユーザー発話も含むため、そのまま履歴には使えない)。
  const [queue, setQueue] = useState<string[]>([]);
  const processingRef = useRef(false);
  const historyRef = useRef<Msg[]>([{ role: 'assistant', content: DEFAULT_OPENING }]);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  // ← 戻るボタンの確認条件(未保存の対話中)と同じ基準で、下部ナビタップ時も確認を挟む。
  useRegisterNavGuard(!done && messages.length > 1);

  // 顧客向けおさらいと同じ、時間指定の深掘りセッション（既定5分・延長可）。
  // 最初の発話が送られてから計測開始。
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, done]);

  async function persist(
    notes: string[],
    fields?: { job?: string; products?: string; age?: string; gender?: string; background?: string; goal?: string },
  ) {
    try {
      await saveSelfOsaraiExtraction(notes, fields ?? {});
      setSaved(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // 送信: 生成中でも受け付け、ユーザー発話を即表示してキューに積む(逐次ワーカーが処理)。
  function sendMessage(text: string) {
    const t = text.trim();
    if (!t || done) return;
    setError(null);
    setInput('');
    setRemainingSec((s) => (s === null ? 300 : s));
    setMessages((m) => [...m, { role: 'user', content: t }]);
    setQueue((q) => [...q, t]);
  }

  // キューを1件ずつ順番に処理するワーカー。historyRefを確定順で更新→次の1件へ進む。
  // processingRefで多重起動を防ぐ(処理中の他state変化は無視)。
  useEffect(() => {
    if (processingRef.current || queue.length === 0 || done) return;
    processingRef.current = true;
    const text = queue[0]!;
    const history = historyRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    selfOsaraiTurn({ message: text, history }, controller.signal)
      .then((res) => {
        historyRef.current = [
          ...history,
          { role: 'user', content: text },
          ...(res.next_question ? [{ role: 'assistant' as const, content: res.next_question }] : []),
        ];
        if (res.next_question) {
          setMessages((m) => [...m, { role: 'assistant', content: res.next_question! }]);
        }
        if (res.done) {
          setDone(true);
          void persist(res.extracted.notes ?? [], res.extracted.fields);
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
  }, [queue, done]);

  // 生成中の停止: 進行中リクエストをabortし、未処理のキューも破棄する。
  function stopGenerating() {
    abortRef.current?.abort();
    setQueue([]);
  }

  function send() {
    sendMessage(input);
  }

  // キューが残っている間(まだ処理中の発話がある間)は、途中の履歴で終えてしまわないよう待つ。
  async function endEarly() {
    if (sending || done || ending || queue.length > 0) return;
    setEnding(true);
    setError(null);
    try {
      const res = await selfOsaraiTurn({ message: '', history: historyRef.current, forceEnd: true });
      setDone(true);
      await persist(res.extracted.notes ?? [], res.extracted.fields);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setEnding(false);
    }
  }

  async function onBack() {
    if (!done && messages.length > 1) {
      const ok = await confirm('ここまでの内容はまだ保存されていません。このまま戻りますか？（内容は失われます）');
      if (!ok) return;
    }
    navigate(-1);
  }

  return (
    <main
      className="screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        // height(固定)でないとflex:1+overflowY:autoが内部スクロールにならず、
        // ページ全体が伸びて入力欄がスクロールで隠れてしまう(バグ修正)。
        height: fromWelcome ? '100dvh' : 'calc(100dvh - 56px)',
        overflow: 'hidden',
      }}
    >
      <header className="screen-header" style={{ position: 'static' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}>
          ← 戻る
        </button>
        <strong>自分をおさらい</strong>
        {remainingSec !== null && !done ? (
          <span style={{ fontSize: 13, color: remainingSec === 0 ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
            {formatMMSS(remainingSec)}
          </span>
        ) : (
          <span style={{ width: 48 }} />
        )}
      </header>

      {remainingSec === 0 && !done && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            borderRadius: 10,
            padding: '8px 12px',
            marginTop: 8,
            fontSize: 13,
          }}
        >
          <span>予定の5分になりました。続けても、ここで終えても大丈夫です。</span>
          <button type="button" onClick={() => setRemainingSec(300)} style={{ padding: '6px 10px', fontSize: 13, whiteSpace: 'nowrap' }}>
            +5分延長
          </button>
        </div>
      )}

      {/* バグ修正: 1つ目のバルーンが固定ヘッダーと被っていたため、上マージンを広げる
          (何度修正しても解消しなかったため、position:stickyを外し余白も大きく取り直した) */}
      <div style={{ flex: 1, overflowY: 'auto', marginTop: 32, padding: '0 0 12px' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
            <div
              style={{
                maxWidth: '80%',
                padding: '10px 14px',
                borderRadius: 14,
                background: m.role === 'user' ? 'var(--color-user-bubble)' : '#fff',
                color: m.role === 'user' ? '#fff' : 'var(--color-text)',
                border: m.role === 'assistant' ? '1px solid var(--color-border)' : 'none',
                whiteSpace: 'pre-wrap',
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
            <div style={{ color: '#9a9183', fontSize: 13 }}>AIが考えています…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {done ? (
        <section style={{ background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <p style={{ margin: '0 0 12px', fontWeight: 700 }}>{saved ? '記録しました。' : '保存中…'}</p>
          <button onClick={() => navigate(fromWelcome ? '/' : '/settings')} style={{ padding: 12, width: '100%' }}>
            {fromWelcome ? 'ホームに戻る' : '設定に戻る'}
          </button>
        </section>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
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
          {messages.length > 1 && (
            <button
              type="button"
              onClick={endEarly}
              disabled={ending || sending || queue.length > 0}
              style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 13, textDecoration: 'underline', padding: '4px 0' }}
            >
              {ending ? '保存中…' : 'ここまでで終える'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <AutoResizeTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="話したいことを入力…"
              rows={1}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', resize: 'none', fontFamily: 'inherit', fontSize: 15 }}
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
            <button onClick={send} disabled={!input.trim()} style={{ padding: '0 18px', minHeight: 44 }}>
              送信
            </button>
          </div>
        </div>
      )}
      {confirmDialog}
    </main>
  );
}
