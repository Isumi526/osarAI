// Osarai（AI対話おさらい：チャット）★コア — §8-1。
// 人と会ったあと、AIが1問ずつヒアリング→done で顧客カード(interactions/customers)へ自動反映。
// ?customerId=... 付きなら既存顧客のおさらい、無ければ新規（done 時に名前から自動でカード生成）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { osaraiTurn, transcribeAudio } from '../lib/osarai.js';
import { updateInteractionSummary, getCustomer } from '../lib/db.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { useLiveSpeech } from '../hooks/useLiveSpeech.js';
import { TempIcon, TEMP_JA } from '../components/TempIcon.js';
import { MicIcon } from '../components/MicIcon.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { ConfettiBurst } from '../components/ConfettiBurst.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import type { OsaraiExtracted, Temperature } from '@osarai/shared';

type Msg = { role: 'user' | 'assistant'; content: string };

const OPENING_NEW = '今日はどんな方と会いましたか？どんな話をしたか、覚えていることを教えてください。';
const openingForExisting = (name: string) => `${name}さんとの話、振り返ってみましょう。今日はどんな話をしましたか？`;
const TEMPS: Temperature[] = ['hot', 'warm', 'cold'];
// APIの仮名フォールバックはプリフィルせず空にし、必須入力を促す
const prefillName = (isNew: boolean, name: string | null) =>
  isNew && name && name !== '新しく会った人' ? name : '';

// 配列⇔複数行テキストの相互変換（サマリ編集フォーム用）
const toLines = (v?: string[]) => (v ?? []).join('\n');
const fromLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

export function Osarai() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customerId = params.get('customerId');

  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING_NEW }]);
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

  // サマリ確認・修正フォーム（F-02 AC: 生成されたサマリをユーザーが確認・修正できる）
  const [editPoints, setEditPoints] = useState('');
  const [editNeeds, setEditNeeds] = useState('');
  const [editNextActions, setEditNextActions] = useState('');
  const [editTemperature, setEditTemperature] = useState<Temperature | null>(null);
  const [editName, setEditName] = useState('');
  const [isNewCustomer, setIsNewCustomer] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const recorder = useRecorder();
  const liveSpeech = useLiveSpeech();
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

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
    setMessages([{ role: 'assistant', content: OPENING_NEW }]);
    setInput('');
    setSessionId(undefined);
    setDone(false);
    setSavedCustomerId(null);
    setSavedInteractionId(null);
    setError(null);
    setEditPoints('');
    setEditNeeds('');
    setEditNextActions('');
    setEditTemperature(null);
    setEditName('');
    setIsNewCustomer(false);
    setConfirmed(false);
    setConfirming(false);
    setRemainingSec(null);
    setEnding(false);
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

  // 既存顧客のおさらいなら、初回の質問を顧客名入りの文言に差し替える（新規は既定文言のまま）
  useEffect(() => {
    if (!customerId) return;
    getCustomer(customerId)
      .then((c) => {
        if (c?.name) {
          setMessages([{ role: 'assistant', content: openingForExisting(c.name) }]);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

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
      setRemainingSec((s) => (s === null ? 300 : s)); // 最初の送信でタイマー開始（既定5分）
      if (res.next_question) {
        setMessages((m) => [...m, { role: 'assistant', content: res.next_question! }]);
      }
      if (res.done) {
        setDone(true);
        setSavedCustomerId(res.customerId);
        setSavedInteractionId(res.interactionId);
        setIsNewCustomer(res.isNewCustomer);
        setEditName(prefillName(res.isNewCustomer, res.customerName));
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

  // 明示的な終了（達成感UI）: ここまでの内容で強制的にdone扱いにして保存
  async function endEarly() {
    if (!sessionId || sending || done || ending) return;
    setError(null);
    setEnding(true);
    try {
      const res = await osaraiTurn({ message: '', sessionId, customerId, forceEnd: true });
      setDone(true);
      setSavedCustomerId(res.customerId);
      setSavedInteractionId(res.interactionId);
      setIsNewCustomer(res.isNewCustomer);
      setEditName(prefillName(res.isNewCustomer, res.customerName));
      const ext: OsaraiExtracted = res.extracted ?? {};
      setEditPoints(toLines(ext.points));
      setEditNeeds(toLines(ext.needs));
      setEditNextActions(toLines(ext.next_actions));
      setEditTemperature(ext.temperature ?? null);
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
        temperature: editTemperature,
        ...(isNewCustomer ? { name: editName.trim() } : {}),
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

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 56px)' }}>
      <header className="screen-header">
        <button onClick={onBack} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-primary)' }}>← 戻る</button>
        <strong>おさらい</strong>
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
          <button
            type="button"
            onClick={() => setRemainingSec(300)}
            style={{ padding: '6px 10px', fontSize: 13, whiteSpace: 'nowrap' }}
          >
            +5分延長
          </button>
        </div>
      )}

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
              顧客カードに整理しました。
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

            {isNewCustomer && (
              <label style={{ display: 'block', marginBottom: 10 }}>
                お名前（必須）
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="例: 田中太郎"
                  style={{ width: '100%', padding: 10, fontSize: 16, marginTop: 4 }}
                />
              </label>
            )}

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
                      color: 'var(--color-text)',
                      borderRadius: 8,
                    }}
                  >
                    <TempIcon value={t} /> {TEMP_JA[t]}
                  </button>
                ))}
              </div>
            </div>

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
          {sessionId && (
            <button
              type="button"
              onClick={endEarly}
              disabled={ending || sending}
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
            placeholder={recorder.recording ? '録音中…話し終えたら停止' : '話したことを入力…（Cmd/Ctrl+Enterで送信）'}
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
        </div>
      )}
      {confirmDialog}
    </main>
  );
}
