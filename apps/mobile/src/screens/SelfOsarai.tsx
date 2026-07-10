// 自分をおさらいする（既存の顧客向けおさらいとは別・AI対話で自分自身を深掘り）。
// 何度でも実行可能。抽出結果(notes)はprofiles.user_profileに蓄積され、AI戦略相談の
// コンテキストに含まれる。低優先度機能のためテキストのみ(音声入力なし)の軽量実装。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { selfOsaraiTurn } from '../lib/selfOsarai.js';
import { appendUserProfileNotes } from '../lib/db.js';
import { useConfirm } from '../components/ConfirmDialog.js';

type Msg = { role: 'user' | 'assistant'; content: string };

const OPENING = '今日は最近のことでも、ふと考えていることでも、なんでも話してください。';

export function SelfOsarai() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, done]);

  async function persist(notes: string[]) {
    try {
      await appendUserProfileNotes(notes);
      setSaved(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || done) return;
    setError(null);
    setInput('');
    const history = messages;
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setSending(true);
    try {
      const res = await selfOsaraiTurn({ message: text, history });
      if (res.next_question) {
        setMessages((m) => [...m, { role: 'assistant', content: res.next_question! }]);
      }
      if (res.done) {
        setDone(true);
        await persist(res.extracted.notes ?? []);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setInput(text);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setSending(false);
    }
  }

  async function endEarly() {
    if (sending || done || ending) return;
    setEnding(true);
    setError(null);
    try {
      const res = await selfOsaraiTurn({ message: '', history: messages, forceEnd: true });
      setDone(true);
      await persist(res.extracted.notes ?? []);
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
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}>
          ← 戻る
        </button>
        <strong>自分をおさらい</strong>
        <span style={{ width: 48 }} />
      </header>

      <div style={{ flex: 1, overflowY: 'auto', margin: '12px 0' }}>
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
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {done ? (
        <section style={{ background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <p style={{ margin: '0 0 12px', fontWeight: 700 }}>{saved ? '記録しました。' : '保存中…'}</p>
          <button onClick={() => navigate('/settings')} style={{ padding: 12, width: '100%' }}>
            設定に戻る
          </button>
        </section>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
          {messages.length > 1 && (
            <button
              type="button"
              onClick={endEarly}
              disabled={ending || sending}
              style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 13, textDecoration: 'underline', padding: '4px 0' }}
            >
              {ending ? '保存中…' : 'ここまでで終える'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="話したいことを入力…（Cmd/Ctrl+Enterで送信）"
              rows={1}
              disabled={sending}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: '1px solid var(--color-border)', resize: 'none', fontFamily: 'inherit', fontSize: 15 }}
            />
            <button onClick={send} disabled={sending || !input.trim()} style={{ padding: '0 18px', minHeight: 44 }}>
              送信
            </button>
          </div>
        </div>
      )}
      {confirmDialog}
    </main>
  );
}
