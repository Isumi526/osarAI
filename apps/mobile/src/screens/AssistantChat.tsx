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
import { ASSISTANT_OPENING, ASSISTANT_HINTS } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };
type Phase = 'chatting' | 'reviewing' | 'committed';

const toLines = (v: string[]) => v.join('\n');
const fromLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);
// datetime-local / date 入力とISO文字列の相互変換
const toLocalInput = (iso: string, withTime: boolean) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}` : date;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

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
        {phase === 'chatting' && sessionId ? (
          <button
            type="button"
            onClick={endAndReview}
            disabled={ending || sending || queue.length > 0}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: 'var(--color-primary)' }}
          >
            {ending ? '整理中…' : '整理する'}
          </button>
        ) : (
          <span style={{ width: 48 }} />
        )}
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
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            zIndex: 80,
          }}
        >
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
      )}
      {confirmDialog}
    </main>
  );
}

// 保存前の確認カード。AIの抽出をそのまま保存せず、必ずユーザーが目で見て直せるようにする。
function ReviewCard({
  proposals,
  setProposals,
  committing,
  onCommit,
  onBackToChat,
}: {
  proposals: Proposals;
  setProposals: (p: Proposals) => void;
  committing: boolean;
  onCommit: () => void;
  onBackToChat: () => void;
}) {
  const empty =
    proposals.people.length === 0 &&
    proposals.schedules.length === 0 &&
    proposals.tasks.length === 0 &&
    proposals.self_notes.length === 0;

  return (
    <section
      style={{
        marginTop: 16,
        padding: 16,
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        display: 'grid',
        gap: 16,
      }}
    >
      <div>
        <strong>この内容で登録します</strong>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          間違いがあればここで直してください。保存するまで登録されません。
        </p>
      </div>

      {empty && <p style={{ color: 'var(--color-text-muted)' }}>登録する内容は見つかりませんでした。</p>}

      {proposals.people.map((p, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              つながり{p.customer_id ? '（登録済み）' : '（新規）'}
            </span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, people: proposals.people.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="このつながりを登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={p.name}
            onChange={(e) =>
              setProposals({
                ...proposals,
                people: proposals.people.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
              })
            }
            placeholder="お名前"
            style={{ padding: 10, fontSize: 15 }}
          />
          <LinesField
            label="要点"
            value={p.points}
            onChange={(v) =>
              setProposals({ ...proposals, people: proposals.people.map((x, j) => (j === i ? { ...x, points: v } : x)) })
            }
          />
          <LinesField
            label="ニーズ"
            value={p.needs}
            onChange={(v) =>
              setProposals({ ...proposals, people: proposals.people.map((x, j) => (j === i ? { ...x, needs: v } : x)) })
            }
          />
          <LinesField
            label="次アクション"
            value={p.next_actions}
            onChange={(v) =>
              setProposals({
                ...proposals,
                people: proposals.people.map((x, j) => (j === i ? { ...x, next_actions: v } : x)),
              })
            }
          />
        </div>
      ))}

      {proposals.schedules.map((s, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>予定</span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, schedules: proposals.schedules.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="この予定を登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={s.title}
            onChange={(e) =>
              setProposals({
                ...proposals,
                schedules: proposals.schedules.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
              })
            }
            placeholder="予定のタイトル"
            style={{ padding: 10, fontSize: 15 }}
          />
          <input
            type="datetime-local"
            value={toLocalInput(s.start_at, true)}
            onChange={(e) => {
              const start = fromLocalInput(e.target.value);
              if (!start) return;
              setProposals({
                ...proposals,
                schedules: proposals.schedules.map((x, j) =>
                  j === i ? { ...x, start_at: start, end_at: new Date(Date.parse(start) + 3600_000).toISOString() } : x,
                ),
              });
            }}
            style={{ padding: 10, fontSize: 14 }}
          />
        </div>
      ))}

      {proposals.tasks.map((t, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>タスク</span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, tasks: proposals.tasks.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="このタスクを登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={t.title}
            onChange={(e) =>
              setProposals({
                ...proposals,
                tasks: proposals.tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
              })
            }
            placeholder="やること"
            style={{ padding: 10, fontSize: 15 }}
          />
          <input
            type="date"
            value={t.due_at ? toLocalInput(t.due_at, false) : ''}
            onChange={(e) =>
              setProposals({
                ...proposals,
                tasks: proposals.tasks.map((x, j) =>
                  j === i ? { ...x, due_at: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null } : x,
                ),
              })
            }
            style={{ padding: 10, fontSize: 14 }}
          />
        </div>
      ))}

      {proposals.self_notes.length > 0 && (
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <LinesField
            label="自分についての気づき"
            value={proposals.self_notes}
            onChange={(v) => setProposals({ ...proposals, self_notes: v })}
          />
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" onClick={onCommit} disabled={committing || empty}>
          {committing ? '保存中…' : 'この内容で保存'}
        </button>
        <button
          type="button"
          onClick={onBackToChat}
          style={{ background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          まだ話す
        </button>
      </div>
    </section>
  );
}

function LinesField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
      {label}（1行に1つ）
      <AutoResizeTextarea
        value={toLines(value)}
        onChange={(e) => onChange(fromLines(e.target.value))}
        rows={1}
        style={{ padding: 10, fontSize: 14, fontFamily: 'inherit', border: '1px solid var(--color-border)', borderRadius: 8, resize: 'none' }}
      />
    </label>
  );
}
