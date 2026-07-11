// 自分をおさらいする（既存の顧客向けおさらいとは別・AI対話で自分自身を深掘り）。
// 何度でも実行可能。抽出結果(notes)はprofiles.user_profileに蓄積され、AI戦略相談の
// コンテキストに含まれる。低優先度機能のためテキストのみ(音声入力なし)の軽量実装。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { selfOsaraiTurn } from '../lib/selfOsarai.js';
import { getMyProfile, saveSelfOsaraiExtraction } from '../lib/db.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';

type Msg = { role: 'user' | 'assistant'; content: string };

const DEFAULT_OPENING = '今日は最近のことでも、ふと考えていることでも、なんでも話してください。';

// 議事録『review(2回目)』要望: 初回はまず名前を確認し、仕事・扱っている商品が
// 未登録なら優先的にヒアリングする。名前は通常signup時のdisplay_nameで既に分かって
// いることが多いため、未登録の場合のみ聞く(AC①)。
function decideOpening(displayName: string | null, job: string | undefined, products: string | undefined): string {
  if (!displayName) return 'はじめまして。まずはお名前を教えてください。';
  if (!job) return `${displayName}さん、こんにちは。まずはどんなお仕事をされているか教えてください。`;
  if (!products) return `${displayName}さん、こんにちは。どんな商品・サービスを扱っていますか？`;
  return DEFAULT_OPENING;
}

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

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

  // まだ何もやり取りしていない(初回ターン前)なら、名前・未登録項目に応じた挨拶に差し替える。
  useEffect(() => {
    getMyProfile()
      .then((p) => {
        if (!p) return;
        const up = (p.user_profile as { job?: string; products?: string } | null) ?? {};
        const opening = decideOpening(p.display_name, up.job, up.products);
        setMessages((m) => (m.length === 1 && m[0]!.role === 'assistant' ? [{ role: 'assistant', content: opening }] : m));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function send() {
    const text = input.trim();
    if (!text || sending || done) return;
    setError(null);
    setInput('');
    setRemainingSec((s) => (s === null ? 300 : s));
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
        await persist(res.extracted.notes ?? [], res.extracted.fields);
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
      <header className="screen-header">
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
            <AutoResizeTextarea
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
