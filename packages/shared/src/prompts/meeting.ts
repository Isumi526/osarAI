// 会議録音（Phase2・T7）の議事録プロンプト。
// 1対1・1時間級の「自己紹介／仕事紹介／どんな人とつながりたいか」の面談を、次回会う直前に
// 読み返して思い出せる固定セクション型のペラ一にする（D5・2026-09-13 人確認）。
// 出力は markdown ではなくプレーンテキスト（クライアントは pre-wrap でそのまま描画するため）。

export const MEETING_MINUTES_SECTIONS = [
  '会議の概要',
  '相手の事業・プロフィール',
  '相手がつながりたい人・求めていること',
  '自分が約束したこと',
  '次回の予定',
  '決定事項・その他',
] as const;

export interface MeetingMinutesContext {
  /** JSTの会議日時ラベル（例: 2026年9月12日(土) 14:00） */
  meetingAt: string;
  /** 所要時間ラベル（例: 58分）。不明なら空 */
  duration: string;
  /** 全文文字起こし（話者ラベル付きなら「自分:」「相手1:」等） */
  transcript: string;
  /** ユーザー自身について（プロフィール要約）。任意 */
  userContext?: string;
}

export function buildMeetingMinutesPrompt(ctx: MeetingMinutesContext): string {
  const sections = MEETING_MINUTES_SECTIONS.map((s) => `【${s}】`).join('\n');
  return [
    `次の会議の全文文字起こしから、後日その相手に会う直前に読み返して思い出せる「ペラ一の議事録」を日本語で作成してください。`,
    `- 以下の見出しを必ずこの順で使い、各見出しの下に箇条書き（「- 」始まり）で書く。該当が無い見出しは「- 特になし」。`,
    `- 全体で400〜800字程度。話し言葉のまま引用せず、要点に整理する。`,
    `- 文字起こしに無いことを推測で補わない。固有名詞は文字起こしの表記に従う。`,
    `- 「自分:」は録音者本人（ユーザー）、「相手1:」等は会議相手の発言。誰の発言かを踏まえる。`,
    `- 見出し以外の装飾（#、**、前置き、解説）は付けない。プレーンテキストで出力する。`,
    ``,
    `会議日時: ${ctx.meetingAt}${ctx.duration ? `（所要 ${ctx.duration}）` : ''}`,
    ctx.userContext ? `ユーザー自身について:\n${ctx.userContext}` : '',
    ``,
    `見出し:`,
    sections,
    ``,
    `---`,
    ctx.transcript,
    `---`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
