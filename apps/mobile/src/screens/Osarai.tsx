// Osarai（AI対話おさらい：チャット）★コア — §8-1。
// 人と会ったあと、AIが1問ずつヒアリング→done で顧客カード(interactions/customers)へ自動反映。
// ?customerId=... 付きなら既存顧客のおさらい、無ければ新規（done 時に名前から自動でカード生成）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { osaraiTurn, transcribeAudio } from '../lib/osarai.js';
import { updateInteractionSummary } from '../lib/db.js';
import { useRecorder } from '../hooks/useRecorder.js';
import type { OsaraiExtracted, Temperature } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };

const OPENING = '今日はどんな方と会いましたか？どんな話をしたか、覚えていることを教えてください。';
const TEMPS: Temperature[] = ['hot', 'warm', 'cold'];
const TEMP_LABEL: Record<Temperature, string> = { hot: '🔥 hot', warm: '☀️ warm', cold: '❄️ cold' };

// 配列⇔複数行テキストの相互変換（サマリ編集フォーム用）
const toLines = (v?: string[]) => (v ?? []).join('\n');
const fromLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

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
  const [savedInteractionId, setSavedInteractionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  // サマリ確認・修正フォーム（F-02 AC: 生成されたサマリをユーザーが確認・修正できる）
  const [editPoints, setEditPoints] = useState('');
  const [editNeeds, setEditNeeds] = useState('');
  const [editNextActions, setEditNextActions] = useState('');
  const [editTemperature, setEditTemperature] = useState<Temperature | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
        setSavedInteractionId(res.interactionId);
        const ext: OsaraiExtracted = res.extracted ?? {};
        setEditPoints(toLines(ext.points));
        setEditNeeds(toLines(ext.needs));
        setEditNextActions(toLines(ext.next_actions));
        setEditTemperature(ext.temperature ?? null);
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

  async function onConfirmSummary() {
    if (!savedInteractionId || !savedCustomerId) return;
    setConfirming(true);
    setError(null);
    try {
      await updateInteractionSummary(savedInteractionId, savedCustomerId, {
        points: fromLines(editPoints),
        needs: fromLines(editNeeds),
        next_actions: fromLines(editNextActions),
        temperature: editTemperature,
      });
      setConfirmed(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setConfirming(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Shift+Enter または Ctrl+Enter のみ送信。Enter単独は誤送信防止のため無視。
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  }

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-primary)' }}>← 戻る</button>
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
        {sending && (
          <div style={{ justifySelf: 'start', color: '#9a9183', fontSize: 13 }}>AIが考えています…</div>
        )}
        {transcribing && (
          <div style={{ justifySelf: 'end', color: '#9a9183', fontSize: 13 }}>文字起こし中…</div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {/* 完了: サマリ確認・修正 → 保存確認（F-02 AC） */}
      {done ? (
        confirmed ? (
          <section
            style={{ background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 12, padding: 16 }}
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
          <section
            style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, padding: 16 }}
          >
            <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
              AIが整理しました。内容を確認・修正してください。
            </p>

            <div style={{ marginBottom: 10 }}>
              温度感
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                {TEMPS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEditTemperature(editTemperature === t ? null : t)}
                    style={{
                      flex: 1,
                      padding: 10,
                      border: editTemperature === t ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                      background: editTemperature === t ? 'var(--color-primary-light)' : '#fff',
                      borderRadius: 8,
                    }}
                  >
                    {TEMP_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>

            <label style={{ display: 'block', marginBottom: 10 }}>
              要点（1行に1つ）
              <textarea
                value={editPoints}
                onChange={(e) => setEditPoints(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 10 }}>
              ニーズ（1行に1つ）
              <textarea
                value={editNeeds}
                onChange={(e) => setEditNeeds(e.target.value)}
                rows={2}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 12 }}>
              次アクション（1行に1つ）
              <textarea
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
                border: '1px solid var(--color-border)',
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
            placeholder={recorder.recording ? '録音中…話し終えたら停止' : '話したことを入力…（Shift+Enterで送信）'}
            rows={1}
            disabled={sending || recorder.recording}
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
