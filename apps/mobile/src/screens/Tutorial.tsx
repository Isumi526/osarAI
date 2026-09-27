// 使い方（チュートリアル）。2026-08-06 UI/UX刷新で追加。
// ITに不慣れなユーザーでも「何ができるか」「どう使えばいいか」が分かるよう、
// 実際の操作順にステップで説明する。ホーム右上からいつでも開ける。
// 2026-09-27: 会議録音が主導線になったので手順を差し替え（デザインは据え置き）。
//   オンライン会議はパソコン（Chrome）、対面はスマホ、という使い分けは人の判断（D3・iPhone
//   単体で Zoom しながら録音するのは iOS の仕様上できない）。文言は MeetingRecord の案内と揃える。
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';

interface Step {
  title: string;
  body: string;
  /** 実際に話す文例（そのまま真似できる形で見せる） */
  example?: string;
  /** example の見出し（既定「話し方の例」） */
  exampleLabel?: string;
  points?: string[];
}

const STEPS: Step[] = [
  {
    title: '下の真ん中の「録音」から始めます',
    body: '人と会う時は、まずこれを押します。どの画面からでも押せます。オンラインの会議はパソコンで、対面で会う時はスマホで録音します。',
    points: [
      'パソコンは Chrome か Edge でこのアプリを開いてください',
      'スマホは対面の商談用です（Zoom の相手の声はスマホでは取り込めません）',
    ],
  },
  {
    title: 'パソコン：Zoom の前に「録音を開始」',
    body: '共有の画面が出たら「画面全体」を選び、「システム音声を共有」がオンになっているのを確かめて「共有」を押します。これで録音が始まります。',
    points: [
      '相手の画面には何も表示されません（会議にボットは入りません）。録音するときは、相手に一言伝えておくのがおすすめです',
      '初回だけ、macOS の「画面収録」の許可が必要です',
      'Zoom をブラウザで開いている場合は、そのタブを選んで「タブの音声も共有」をオンにします',
      '「自分の声を録るマイク」は「自動」のままで大丈夫です。声が入らない時は「マイクをテスト」で確かめられます',
    ],
  },
  {
    title: 'スマホ：机に置いて「録音を開始」',
    body: '対面で会う時は、スマホを二人の声が届く場所に置いて録音します。',
    points: [
      '録音中はこの画面を開いたままにしてください（画面は自動では消えません）',
      '電源ボタンで画面を消したり、他のアプリに切り替えると、その間は録音されません',
    ],
  },
  {
    title: '終わったら「収録を終了」',
    body: '押すと、文字起こしと議事録づくりが始まります。1時間の会議でも、1〜2分ほどで終わります。',
    points: [
      'Zoom を先に閉じても、それまでの録音は残ります',
      '途中でタブを閉じてしまっても、次に開いた時に「前回の続き」から再開できます',
    ],
  },
  {
    title: '確認しなくても、自動で保存されます',
    body: '議事録・予定・TODO・会った人の情報が、そのままそれぞれの場所に残ります。',
    points: [
      '予定タブ … 次に会う約束など、日時が決まったもの',
      'TODOタブ … 自分が約束したこと（「資料を送る」など）',
      'つながり … 会った人のカードに、議事録が履歴として残ります',
      '相手の名前が会話に出なかった時は、保存後の画面で名前を入れると紐付きます',
    ],
  },
  {
    title: '間違いは、あとから直せます',
    body: '議事録は「編集」を押すと、表示されたままの形で直せます。変更は自動で保存されます。',
    points: [
      'ホームの「最近の会議」→「会議の記録」から、過去の会議をいつでも開けます',
      '予定やTODOは、それぞれのタブで直したり消したりできます',
    ],
  },
  {
    title: '次に会う前に、見返す・相談する',
    body: 'ホームの「次に会う人」から、前回の話をすぐ開けます。相手のカードの「この人について相談」から聞くと、過去の会議を踏まえて答えます。',
    exampleLabel: '相談の例',
    example: '来週、村上さんと2回目に会います。前回の話を踏まえて、何を聞いたらいいですか？',
    points: ['会議以外のちょっとしたメモは、ホームの「AIに相談する・メモを話す」から声で残せます'],
  },
];

export function Tutorial() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const current = STEPS[step]!;

  return (
    <main className="screen">
      <ScreenHeader title="使い方" back={{ to: '/settings', label: 'マイページへ戻る' }} />

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
            <div style={{ fontSize: 12, color: 'var(--color-primary-dark)', marginBottom: 6 }}>{current.exampleLabel ?? '話し方の例'}</div>
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
          <button type="button" onClick={() => navigate('/meeting')} style={{ flex: 2, padding: 12 }}>
            会議を録音してみる
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
