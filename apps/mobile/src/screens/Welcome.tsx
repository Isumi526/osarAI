// 初回ログイン時のウェルカム/チュートリアル画面。§10の追加画面。
// 2026-09-27: 会議録音（録音→議事録/予定/タスク/つながりを自動保存）が主導線になったので
// 訴求の順番を入れ替えた（旧: 入口は「AIと話す」1つ・音声入力主体）。デザインは据え置き。
// 最後は「ホームへ」で通常のホームに入る。「ホーム画面に追加」の案内はホームにだけ出す。
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

// 各ステップのイラスト。外部素材はライセンス確認が困難なため、既存のConfettiBurst/
// NavIconsと同様、ライセンス懸念のない自作の簡易SVGで代替(技術判断)。
const svgProps = {
  width: 88,
  height: 88,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'var(--color-primary)',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function HeartIllustration() {
  return (
    <svg {...svgProps}>
      <path d="M12 20.5s-7.5-4.6-9.8-9C.8 8 2 4.5 5.3 3.6 8 2.9 10.4 4 12 6.3 13.6 4 16 2.9 18.7 3.6 22 4.5 23.2 8 21.8 11.5c-2.3 4.4-9.8 9-9.8 9z" />
    </svg>
  );
}
// 次に会う前に読み返す議事録＝ノート
function NotesIllustration() {
  return (
    <svg {...svgProps}>
      <path d="M6 2.5h9l3.5 3.5v15.5H6z" />
      <path d="M15 2.5V6h3.5" />
      <path d="M9 10h6.5M9 13.5h6.5M9 17h4" />
    </svg>
  );
}
// 会議の前に押す録音ボタン＝マイク
function MicIllustration() {
  return (
    <svg {...svgProps}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </svg>
  );
}
// 議事録・予定・タスク・つながりへ自動で保存＝カレンダー/チェック/人の3つ＋きらめき
function SortIllustration() {
  return (
    <svg {...svgProps}>
      <rect x="2.5" y="4" width="7" height="6.5" rx="1.2" />
      <path d="M2.5 6.3h7M5 3v2.3M7 3v2.3" />
      <path d="m2.8 15 1.4 1.4 2.6-2.7" />
      <path d="M9 15h1.2" />
      <circle cx="17.5" cy="5.8" r="2.3" />
      <path d="M13.7 12.2a4.2 4.2 0 0 1 7.6 0" />
      <path d="M14.5 16.5 15 18l1.5.5-1.5.5-.5 1.5-.5-1.5L12 18.5l1.5-.5z" />
    </svg>
  );
}
// 過去の会議を踏まえてAIが相談に乗る＝電球
function LightbulbIllustration() {
  return (
    <svg {...svgProps}>
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
    body: 'osarAIは、人と会って話したことをAIが代わりに覚えておき、大切な人との関係を忘れずに育てるための相棒アプリです。',
    Illustration: HeartIllustration,
  },
  {
    titleLines: ['会う前に、', 'ボタンを1つ押すだけ'],
    body: 'Zoomの前や、対面で会う前に「会議を録音する」を押すだけ。相手の画面には何も表示されません（会議にボットは入りません）。',
    Illustration: MicIllustration,
  },
  {
    titleLines: ['終わったら、', 'AIが全部まとめて保存'],
    body: '議事録・次の予定・自分のやること・会った人の情報を、AIがまとめて自動で保存します。カレンダーもタスクも、手で入れなくて大丈夫です。',
    Illustration: SortIllustration,
  },
  {
    titleLines: ['次に会う前に、', '前回の話を思い出せる'],
    body: '会った人のカードを開けば、これまでの議事録がすぐ読めます。久しぶりに会う人でも、前に何を話したかで慌てません。',
    Illustration: NotesIllustration,
  },
  {
    titleLines: ['次の一手は、', 'AIに相談できる'],
    body: '過去の会議を踏まえて、「この人に次どう連絡する？」といった相談に具体的に答えます。会議以外のちょっとしたメモは「AIと話す」から声で残せます。',
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
        {/* 「ホーム画面に追加」の案内はホーム側で出す（2026-09-27 人判断・ここでは出さない） */}
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
          {/* スキップボタンは削除(離脱を防ぐため最後まで進めないと先に行けないようにする・議事録要望) */}
          <button type="button" onClick={() => setStep((s) => s + 1)} style={{ flex: 2, padding: 12 }}>
            次へ
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 最後の分岐は「ホームへ」に統一（旧: 自分をおさらいするへ誘導）。 */}
          <button type="button" onClick={() => navigate('/')} style={{ padding: 14, fontSize: 16 }}>
            ホームへ
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
