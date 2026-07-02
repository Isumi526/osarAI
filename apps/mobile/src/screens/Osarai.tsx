// Osarai（AI対話おさらい：チャット）★コア — §8-1。
// 人と会ったあと、AIが1問ずつヒアリング→done で顧客カード(interactions/customers)へ自動反映。
// ?customerId=... 付きなら既存顧客のおさらい、無ければ新規（done 時に名前から自動でカード生成）。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { osaraiTurn, transcribeAudio } from '../lib/osarai.js';
import { useRecorder } from '../hooks/useRecorder.js';

type Msg = { role: 'user' | 'assistant'; content: string };

const OPENING = '今日はどんな方と会いましたか？どんな話をしたか、覚えていることを教えてください。';

export function Osarai() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customerId = params.get('customerId');

  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING }]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [savedCustomerId, setSavedCustomerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRecorder();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, done]);

  // マイク: 録音中なら停止→文字起こし→入力欄へ、そうでなければ録音開始
  async function toggleMic() {
    if (sending || transcribing || done) return;
    setError(null);
    if (recorder.recording) {
      const blob = await recorder.stop();
      if (!blob) return;
      setTranscribing(true);
      try {
        const text = await transcribeAudio(blob);
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setTranscribing(false);
      }
    } else {
      await recorder.start();
      if (recorder.error) setError(recorder.error);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || done) return;
    setError(null);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setSending(true);
    try {
      const res = await osaraiTurn({ message: text, sessionId, customerId });
      setSessionId(res.sessionId);
      if (res.next_question) {
        setMessages((m) => [...m, { role: 'assistant', content: res.next_question! }]);
      }
      if (res.done) {
        setDone(true);
        setSavedCustomerId(res.customerId);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      // 失敗したユーザー発話を入力欄に戻す
      setInput(text);
      setMessages((m) => m.slice(0, -1));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/">← ホーム</Link>
        <strong>おさらい</strong>
        <span style={{ width: 48 }} />
      </header>

      {/* 対話 */}
      <div style={{ flex: 1, display: 'grid', gap: 10, padding: '16px 0', alignContent: 'start' }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '80%',
              background: m.role === 'user' ? '#2d7d46' : '#fff',
              color: m.role === 'user' ? '#fff' : 'inherit',
              border: m.role === 'user' ? 'none' : '1px solid #e7e1d6',
              borderRadius: 14,
              padding: '10px 14px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            {m.content}
          </div>
        ))}
        {sending && (
          <div style={{ justifySelf: 'start', color: '#9a9183', fontSize: 13 }}>AIが考えています…</div>
        )}
        {transcribing && (
          <div style={{ justifySelf: 'end', color: '#9a9183', fontSize: 13 }}>文字起こし中…</div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {/* 完了 */}
      {done ? (
        <section
          style={{ background: '#eef7f0', border: '1px solid #cfe6d6', borderRadius: 12, padding: 16 }}
        >
          <p style={{ margin: '0 0 12px' }}>✅ おさらい完了。顧客カードに整理しました。</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {savedCustomerId && (
              <button
                onClick={() => navigate(`/customers/${savedCustomerId}`)}
                style={{ flex: 1, padding: 12 }}
              >
                カードを見る
              </button>
            )}
            <button onClick={() => navigate('/')} style={{ flex: 1, padding: 12 }}>
              ホームへ
            </button>
          </div>
        </section>
      ) : (
        <div style={{ display: 'flex', gap: 8, paddingBottom: 8, alignItems: 'flex-end' }}>
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
                border: '1px solid #e7e1d6',
                borderRadius: 10,
              }}
            >
              {recorder.recording ? '■ 停止' : '🎙'}
            </button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={recorder.recording ? '録音中…話し終えたら停止' : '話したことを入力…'}
            rows={1}
            disabled={sending || recorder.recording}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 10,
              border: '1px solid #e7e1d6',
              resize: 'none',
              fontFamily: 'inherit',
              fontSize: 15,
            }}
          />
          <button
            onClick={send}
            disabled={sending || transcribing || !input.trim()}
            style={{ padding: '0 18px', minHeight: 44 }}
          >
            送信
          </button>
        </div>
      )}
    </main>
  );
}
