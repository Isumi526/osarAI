// 使い方（チュートリアル）。2026-08-06 UI/UX刷新で追加。
// ITに不慣れなユーザーでも「何ができるか」「どう話せばいいか」が分かるよう、
// 実際の操作順にステップで説明する。ホーム右上からいつでも開ける。
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';

interface Step {
  title: string;
  body: string;
  /** 実際に話す文例（そのまま真似できる形で見せる） */
  example?: string;
  points?: string[];
}

const STEPS: Step[] = [
  {
    title: 'ホームの「AIと話す」から始めます',
    body: 'アプリでやることは、基本これ1つだけです。人と会ったあとや、1日の終わりに開いてください。',
    points: [
      '入口はホームの大きなボタン1つ。迷うところはありません',
      '声でもテキストでも話せます（マイクのボタンを押すと録音が始まります）',
    ],
  },
  {
    title: 'まとめて、思い出すままに話す',
    body: '整理しながら話す必要はありません。複数の人・複数の予定・やることを、ひとまとめに話して大丈夫です。AIが後から仕分けします。',
    example:
      '今日は交流会に参加しました。山本さんと話して、来週の火曜14時にカフェで会う約束になりました。それまでに資料を送ります。田中さんとも名刺交換して、保険の見直しを考えているそうです。',
    points: ['「えーと」「あの」など、話し言葉のままで構いません', '思い出したことは後から足せます'],
  },
  {
    title: 'AIが聞き返して、深掘りしてくれます',
    body: '話し足りないところをAIが1つずつ聞いてくれます。答えるだけで、相手の情報が自然に増えていきます。',
    points: [
      '相談したいことがあれば、そのまま質問しても大丈夫です',
      '自分自身のこと（仕事・目標・悩み）を話すのもOKです',
    ],
  },
  {
    title: '話し終わったら「整理する」',
    body: '入力欄の上のボタンを押すと、話した内容から「つながり」「予定」「タスク」に分けた案が出ます。',
    points: [
      '保存する前に必ず確認できます。間違いはその場で直せます',
      '登録したくないものは × で外せます',
      '「相手」を選び直せば、予定やタスクを別の人に紐付けられます',
    ],
  },
  {
    title: '保存すると、それぞれの場所に残ります',
    body: '「この内容で保存」を押すと、下のタブから見返せるようになります。',
    points: [
      '予定タブ … カレンダーに登録されます',
      'タスクタブ … 期限順に並びます。終わったらチェックで完了',
      'マイページ → つながり一覧 … 会った人の情報と履歴が残ります',
    ],
  },
  {
    title: '次に会う前に、見返す',
    body: '久しぶりに会う人でも、前回話したことをすぐ思い出せます。「この人に何を話せばいい？」とAIに相談することもできます。',
    points: ['つながりの詳細から、その人についてAIに相談できます'],
  },
];

export function Tutorial() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <main className="screen">
      <ScreenHeader>
        <Link to="/">← ホーム</Link>
        <strong>使い方</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      {/* 進捗ドット。今どこにいるかが一目で分かるようにする */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', margin: '16px 0' }}>
        {STEPS.map((_, i) => (
          <span
            key={i}
            style={{
              width: i === step ? 20 : 8,
              height: 8,
              borderRadius: 999,
              background: i === step ? 'var(--color-primary)' : 'var(--color-border)',
            }}
          />
        ))}
      </div>

      <section
        style={{
          background: '#fff',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 20,
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          STEP {step + 1} / {STEPS.length}
        </div>
        <h2 style={{ fontSize: 19, margin: 0, lineHeight: 1.5 }}>{current.title}</h2>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: 'var(--color-text)' }}>{current.body}</p>

        {current.example && (
          <div
            style={{
              background: 'var(--color-primary-light)',
              border: '1px solid var(--color-primary-border)',
              borderRadius: 10,
              padding: 14,
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--color-primary-dark)', marginBottom: 6 }}>話し方の例</div>
            {current.example}
          </div>
        )}

        {current.points && (
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
            {current.points.map((p, i) => (
              <li key={i} style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-muted)' }}>
                {p}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          戻る
        </button>
        {isLast ? (
          <button type="button" onClick={() => navigate('/chat')} style={{ flex: 2, padding: 12 }}>
            AIと話してみる
          </button>
        ) : (
          <button type="button" onClick={() => setStep((s) => s + 1)} style={{ flex: 2, padding: 12 }}>
            次へ
          </button>
        )}
      </div>
    </main>
  );
}
