// 初回ログイン時のウェルカム/チュートリアル画面。§10の追加画面(業務判断で仕様変更・
// 議事録『review』フィードバック: いきなり自分をおさらいするに飛ばすと驚くため、
// ステップ式のアプリ紹介を挟んでから、最後に2つの入口ボタンを出す。
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

const STEPS: { title: string; body: string }[] = [
  {
    title: '忙しくても、人を大切にできる自分に。',
    body: 'osarAIは、人と会ったあとの「おさらい」を通じて、大切な人との関係を忘れずに育てるための相棒です。',
  },
  {
    title: '会ったあと5分の「AI対話おさらい」',
    body: 'AIが1問ずつ自然に聞いてくれるので、話すだけで顧客カードが自動で整理されます。',
  },
  {
    title: '顧客カード＋タイムライン',
    body: '会った人の情報や会話の履歴が、いつでも見返せる形で残っていきます。',
  },
  {
    title: 'AIに戦略を相談できる',
    body: '「次に誰にどう連絡すればいいか」など、あなたの状況を踏まえてAIが一緒に考えます。',
  },
];

export function Welcome() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 56px)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>{current.title}</h1>
        <p style={{ fontSize: 16, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>{current.body}</p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, margin: '16px 0' }}>
        {STEPS.map((_, i) => (
          <span
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: i === step ? 'var(--color-primary)' : 'var(--color-border)',
            }}
          />
        ))}
      </div>

      {!isLast ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
          >
            スキップ
          </button>
          <button type="button" onClick={() => setStep((s) => s + 1)} style={{ flex: 2, padding: 12 }}>
            次へ
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button type="button" onClick={() => navigate('/self-osarai')} style={{ padding: 14, fontSize: 16 }}>
            まずは自分のことを5分おさらいしてみる
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{ padding: 14, fontSize: 16, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            早速使ってみる
          </button>
        </div>
      )}
    </main>
  );
}
