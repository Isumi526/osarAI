// 統合AIチャット（2026-08-06 UI/UX刷新）★アプリ唯一のメイン入口。
// 「おさらい」「相談」「自分をおさらい」を1画面に統合し、AIが発言から意図を判断する。
// 話した内容から スケジュール / つながり / タスク を抽出し、保存前に確認・修正できる。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { assistantTurn, assistantCommit, type Proposals } from '../lib/assistant.js';
import { transcribeAudio } from '../lib/osarai.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { useLiveSpeech } from '../hooks/useLiveSpeech.js';
import { MicIcon } from '../components/MicIcon.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';
import { ConfettiBurst } from '../components/ConfettiBurst.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import { ReviewCard } from '../components/ReviewCard.js';
import { ASSISTANT_OPENING, ASSISTANT_HINTS } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };
type Phase = 'chatting' | 'reviewing' | 'committed';

export function AssistantChat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: ASSISTANT_OPENING }]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState<Phase>('chatting');
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const lastAudioRef = useRef<Blob | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const processingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorder = useRecorder();
  const liveSpeech = useLiveSpeech();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // 人物が曖昧なときの確認チップ（勝手に断定させない）
  const [customerQuestion, setCustomerQuestion] = useState<{
    question: string;
    candidates: { id: string; name: string }[];
    allow_new: boolean;
  } | null>(null);

  // 確認カード（保存前に編集できる抽出結果）
  const [proposals, setProposals] = useState<Proposals | null>(null);
  const [committing, setCommitting] = useState(false);
  const [ending, setEnding] = useState(false);

  // 未保存の対話中は離脱時に確認する（下部ナビ/戻るの両方）
  useRegisterNavGuard(phase !== 'committed' && messages.length > 1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase, proposals]);

  function sendMessage(text: string) {
    const t = text.trim();
    if (!t || phase !== 'chatting') return;
    setError(null);
    setInput('');
    setCustomerQuestion(null);
    setMessages((m) => [...m, { role: 'user', content: t }]);
    setQueue((q) => [...q, t]);
  }

  // キューを1件ずつ順に処理する（AIが考え中でも続けて送信できる）
  useEffect(() => {
    if (processingRef.current || queue.length === 0 || phase !== 'chatting') return;
    processingRef.current = true;
    const text = queue[0]!;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    assistantTurn({ message: text, sessionId }, controller.signal)
      .then((res) => {
        setSessionId(res.sessionId);
        if (res.reply) setMessages((m) => [...m, { role: 'assistant', content: res.reply! }]);
        setCustomerQuestion(res.customer_question);
        if (res.done && res.proposals) {
          setProposals(res.proposals);
          setPhase('reviewing');
          setQueue([]);
        } else {
          setQueue((q) => q.slice(1));
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e instanceof Error ? e.message : e));
        setQueue([]);
      })
      .finally(() => {
        abortRef.current = null;
        setSending(false);
        processingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, sessionId, phase]);

  function stopGenerating() {
    abortRef.current?.abort();
    setQueue([]);
  }

  // 人物確認チップの回答。選んだ相手を明示してもう一度AIに渡す。
  function answerCustomer(idOrNew: string, label: string) {
    setCustomerQuestion(null);
    sendMessage(idOrNew === 'new' ? `${label}は新しく会った人です。` : `${label}さんの話です。`);
  }

  async function endAndReview() {
    if (!sessionId || sending || ending || queue.length > 0) return;
    setEnding(true);
    setError(null);
    try {
      const res = await assistantTurn({ message: '', sessionId, forceEnd: true });
      if (res.proposals) {
        setProposals(res.proposals);
        setPhase('reviewing');
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setEnding(false);
    }
  }

  async function onCommit() {
    if (!sessionId || !proposals || committing) return;
    const unnamed = proposals.people.find((p) => !p.customer_id && !p.name.trim());
    if (unnamed) {
      setError('お名前を入力してください（あとで見分けがつかなくなるため）。');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      await assistantCommit({ sessionId, proposals });
      setPhase('committed');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCommitting(false);
    }
  }

  function startNew() {
    setMessages([{ role: 'assistant', content: ASSISTANT_OPENING }]);
    setInput('');
    setSessionId(undefined);
    setPhase('chatting');
    setProposals(null);
    setError(null);
    setQueue([]);
    setCustomerQuestion(null);
  }

  async function runTranscribe(blob: Blob) {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const text = await transcribeAudio(blob);
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      lastAudioRef.current = null;
    } catch {
      lastAudioRef.current = blob;
      setTranscribeError('文字起こしに失敗しました。通信状況を確認して、もう一度お試しください。');
    } finally {
      setTranscribing(false);
    }
  }

  async function toggleMic() {
    if (sending || transcribing || phase !== 'chatting') return;
    setError(null);
    setTranscribeError(null);
    if (recorder.recording) {
      liveSpeech.stop();
      const blob = await recorder.stop();
      if (!blob) return;
      await runTranscribe(blob);
    } else {
      await recorder.start();
      if (recorder.error) {
        setError(recorder.error);
        return;
      }
      liveSpeech.start();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Enter単独は改行（誤送信防止）。送信はCmd/Ctrl+Enter。
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  async function onBack() {
    if (phase !== 'committed' && messages.length > 1) {
      const ok = await confirm('話した内容はまだ保存されていません。このまま戻りますか？（内容は失われます）');
      if (!ok) return;
    }
    navigate('/');
  }

  // 入力フォームは画面下部に固定。実高さを測って本文のpadding-bottomに反映する（重なり防止）。
  const formRef = useRef<HTMLDivElement>(null);
  const [formHeight, setFormHeight] = useState(0);
  useLayoutEffect(() => {
    const el = formRef.current;
    if (!el || phase !== 'chatting') return;
    const apply = () => setFormHeight(el.offsetHeight);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [phase]);

  return (
    <main className="screen" style={{ paddingBottom: phase === 'chatting' ? formHeight + 16 : 24 }}>
      <ScreenHeader>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}>
          ← ホーム
        </button>
        <strong>AIと話す</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: 14,
              whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? 'var(--color-primary)' : '#fff',
              color: m.role === 'user' ? '#fff' : 'inherit',
              border: m.role === 'user' ? 'none' : '1px solid var(--color-border)',
              fontSize: 15,
              lineHeight: 1.6,
            }}
          >
            {m.content}
          </div>
        ))}
        {sending && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>AIが考えています…</div>}
      </div>

      {/* 開始時の3択ヒント。何を話せばいいか分からない人の入口になる。 */}
      {phase === 'chatting' && messages.length === 1 && !sending && (
        <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
          {ASSISTANT_HINTS.map((h) => (
            <button
              key={h.label}
              type="button"
              onClick={() => sendMessage(h.message)}
              style={{
                padding: 14,
                textAlign: 'left',
                background: '#fff',
                border: '1px solid var(--color-primary-border)',
                color: 'var(--color-text)',
                borderRadius: 12,
                fontSize: 15,
              }}
            >
              {h.label}
            </button>
          ))}
        </div>
      )}

      {/* 人物が曖昧なときの確認（新規の可能性も選べる） */}
      {customerQuestion && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 14 }}>{customerQuestion.question}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {customerQuestion.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => answerCustomer(c.id, c.name)}
                style={{ padding: '8px 14px', background: '#fff', border: '1px solid var(--color-primary-border)', borderRadius: 999, fontSize: 14 }}
              >
                {c.name}さん
              </button>
            ))}
            {customerQuestion.allow_new && (
              <button
                type="button"
                onClick={() => answerCustomer('new', 'その人')}
                style={{ padding: '8px 14px', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 999, fontSize: 14 }}
              >
                新しい人です
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}
      {transcribeError && (
        <p style={{ color: '#c0392b', marginTop: 8, fontSize: 13 }}>
          {transcribeError}
          {lastAudioRef.current && (
            <button
              type="button"
              onClick={() => lastAudioRef.current && runTranscribe(lastAudioRef.current)}
              style={{ marginLeft: 8, padding: '4px 10px', fontSize: 13 }}
            >
              再試行
            </button>
          )}
        </p>
      )}

      {phase === 'reviewing' && proposals && (
        <ReviewCard
          proposals={proposals}
          setProposals={setProposals}
          committing={committing}
          onCommit={onCommit}
          onBackToChat={() => setPhase('chatting')}
        />
      )}

      {phase === 'committed' && (
        <div
          style={{
            marginTop: 24,
            padding: 24,
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            borderRadius: 12,
            textAlign: 'center',
          }}
        >
          <ConfettiBurst />
          <p style={{ fontWeight: 700, margin: '8px 0' }}>整理しました</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '0 0 16px' }}>
            つながり・予定・タスクに反映しました。
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            <button type="button" onClick={startNew}>
              続けて話す
            </button>
            <button type="button" onClick={() => navigate('/')} style={{ background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              ホームに戻る
            </button>
          </div>
        </div>
      )}

      <div ref={bottomRef} />

      {phase === 'chatting' && (
        <div
          ref={formRef}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
            background: 'var(--color-bg)',
            borderTop: '1px solid var(--color-border)',
            padding: '10px 16px',
            display: 'grid',
            gap: 8,
            zIndex: 80,
          }}
        >
          {/* 「話し終わったら整理する」導線。ヘッダーの小さなリンクだと気づかず押しにくい
              という指摘を受け、入力欄のすぐ上の全幅ボタンにした（2026-08-06）。 */}
          {sessionId && (
            <button
              type="button"
              onClick={endAndReview}
              disabled={ending || sending || queue.length > 0}
              style={{
                padding: 12,
                fontSize: 15,
                fontWeight: 700,
                background: 'var(--color-primary-light)',
                border: '1px solid var(--color-primary-border)',
                color: 'var(--color-primary-dark)',
                borderRadius: 10,
              }}
            >
              {ending ? '整理しています…' : '話し終わった・内容を整理する'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
          {/* マイクは入力欄と送信ボタンの間（片手でも押しやすい位置） */}
          {recorder.supported && (
            <button
              type="button"
              onClick={toggleMic}
              disabled={sending || transcribing}
              aria-label={recorder.recording ? '録音を止める' : '音声で話す'}
              style={{
                padding: '0 14px',
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
          {sending && (
            <button
              type="button"
              onClick={stopGenerating}
              aria-label="生成を停止"
              style={{ padding: '0 14px', minHeight: 44, background: 'var(--color-text-muted)' }}
            >
              ■
            </button>
          )}
          <button
            type="button"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || transcribing}
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

