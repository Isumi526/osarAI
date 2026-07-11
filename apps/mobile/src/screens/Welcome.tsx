// 初回ログイン時のウェルカム/チュートリアル画面。§10の追加画面(業務判断で仕様変更・
// 議事録『review』フィードバック: いきなり自分をおさらいするに飛ばすと驚くため、
// ステップ式のアプリ紹介を挟んでから、最後に2つの入口ボタンを出す。
// 2回目のフィードバックで「戻る」ボタン・各ステップのイラスト・下部ナビ非表示を追加。
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

// 各ステップのイラスト。外部素材はライセンス確認が困難なため、既存のConfettiBurst/
// NavIconsと同様、ライセンス懸念のない自作の簡易SVGで代替(技術判断)。
function HeartIllustration() {
  return (
    <svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20.5s-7.5-4.6-9.8-9C.8 8 2 4.5 5.3 3.6 8 2.9 10.4 4 12 6.3 13.6 4 16 2.9 18.7 3.6 22 4.5 23.2 8 21.8 11.5c-2.3 4.4-9.8 9-9.8 9z" />
    </svg>
  );
}
function ChatClockIllustration() {
  return (
    <svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h13v9H9l-4 3.5V13H3z" />
      <circle cx="17.5" cy="16.5" r="4.5" />
      <path d="M17.5 14.5v2l1.3 1.3" />
    </svg>
  );
}
function CardTimelineIllustration() {
  return (
    <svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="8" rx="1.5" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="M11 7h7M11 9h5" />
      <path d="M4 17h16M4 20h10" />
    </svg>
  );
}
function LightbulbIllustration() {
  return (
    <svg width="88" height="88" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1.1 2.1h4.8c.1-.9.5-1.6 1.1-2.1A6 6 0 0 0 12 3z" />
    </svg>
  );
}

// titleは自動改行に任せると中途半端な位置で折り返されるため、キリのいい語句の
// 区切りで改行できるよう行の配列にする(バグ修正)。
const STEPS: { titleLines: string[]; body: string; Illustration: () => React.JSX.Element }[] = [
  {
    titleLines: ['忙しくても、', '人を大切にできる自分に。'],
    body: 'osarAIは、人と会ったあとの「おさらい」を通じて、大切な人との関係を忘れずに育てるための相棒です。',
    Illustration: HeartIllustration,
  },
  {
    titleLines: ['会ったあと5分の', '「AI対話おさらい」'],
    body: 'AIが1問ずつ自然に聞いてくれるので、話すだけで顧客カードが自動で整理されます。',
    Illustration: ChatClockIllustration,
  },
  {
    titleLines: ['顧客カード＋', 'タイムライン'],
    body: '会った人の情報や会話の履歴が、いつでも見返せる形で残っていきます。',
    Illustration: CardTimelineIllustration,
  },
  {
    titleLines: ['AIに', '戦略を相談できる'],
    body: '「次に誰にどう連絡すればいいか」など、あなたの状況を踏まえてAIが一緒に考えます。',
    Illustration: LightbulbIllustration,
  },
];

export function Welcome() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <current.Illustration />
        <h1 style={{ fontSize: 22, margin: '20px 0 16px' }}>
          {current.titleLines.map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {line}
            </span>
          ))}
        </h1>
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
          {!isFirst && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              戻る
            </button>
          )}
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
          <button type="button" onClick={() => navigate('/self-osarai?from=welcome')} style={{ padding: 14, fontSize: 16 }}>
            まずは自分のことを5分おさらいしてみる
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{ padding: 14, fontSize: 16, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            早速使ってみる
          </button>
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            style={{ padding: 8, background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 13 }}
          >
            戻る
          </button>
        </div>
      )}
    </main>
  );
}
