// AiChat（AI戦略相談：scope切替 全体/顧客指定）— §8-3。
// scope=all は全顧客サマリ、customer は対象顧客の履歴を踏まえてコーチが助言。
// ?customerId=... 付きで来たら顧客指定で開始。
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { askAdvice } from '../lib/advice.js';
import { listCustomers, type Customer } from '../lib/db.js';
import type { ChatScope } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };

export function AiChat() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialCustomerId = params.get('customerId');

  const [scope, setScope] = useState<ChatScope>(initialCustomerId ? 'customer' : 'all');
  const [customerId, setCustomerId] = useState<string | null>(initialCustomerId);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatId, setChatId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 顧客指定モード用に一覧を読み込む
  useEffect(() => {
    listCustomers({ status: 'active' })
      .then(setCustomers)
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // scope や対象顧客を変えたら会話をリセット
  function switchScope(next: ChatScope) {
    setScope(next);
    setChatId(undefined);
    setMessages([]);
    if (next === 'all') setCustomerId(null);
  }
  function switchCustomer(id: string) {
    setCustomerId(id || null);
    setChatId(undefined);
    setMessages([]);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    if (scope === 'customer' && !customerId) {
      setError('相談する顧客を選んでください。');
      return;
    }
    setError(null);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setSending(true);
    try {
      const res = await askAdvice({ message: text, scope, customerId, chatId });
      setChatId(res.chatId);
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setInput(text);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Shift+Enter または Ctrl+Enter のみ送信。Enter単独は誤送信防止のため無視。
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  }

  const placeholder =
    scope === 'all' ? '例: 今週フォローすべき人は？（Shift+Enterで送信）' : '例: この人に次どう連絡するのがいい？（Shift+Enterで送信）';

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-primary)' }}>← 戻る</button>
        <strong>AIに相談</strong>
        <span style={{ width: 48 }} />
      </header>

      {/* scope 切替 */}
      <div style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center' }}>
        <select value={scope} onChange={(e) => switchScope(e.target.value as ChatScope)}>
          <option value="all">全体で相談</option>
          <option value="customer">顧客を指定</option>
        </select>
        {scope === 'customer' && (
          <select
            value={customerId ?? ''}
            onChange={(e) => switchCustomer(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">顧客を選択…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 会話 */}
      <div style={{ flex: 1, display: 'grid', gap: 10, padding: '8px 0', alignContent: 'start' }}>
        {messages.length === 0 && (
          <p style={{ color: '#6b6358' }}>
            {scope === 'all'
              ? '担当している顧客全体を踏まえて、次の一手を相談できます。'
              : '選んだ顧客の履歴を踏まえて、次の連絡や提案を相談できます。'}
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '85%',
              background: m.role === 'user' ? '#fd780f' : '#fff',
              color: m.role === 'user' ? '#fff' : 'inherit',
              border: m.role === 'user' ? 'none' : '1px solid var(--color-border)',
              borderRadius: 14,
              padding: '10px 14px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
            }}
          >
            {m.content}
          </div>
        ))}
        {sending && (
          <div style={{ justifySelf: 'start', color: '#9a9183', fontSize: 13 }}>
            コーチが考えています…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, paddingBottom: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={sending}
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
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          style={{ padding: '0 18px', minHeight: 44 }}
        >
          送信
        </button>
      </div>
    </main>
  );
}
