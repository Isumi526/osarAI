// おさらい対話のシステムプロンプト雛形（§8-1）。
// サーバー側 /api/osarai/turn から使用（クライアントから直接Geminiは叩かない）。
// 実際のターン処理ロジックはフェーズ6で実装。ここでは雛形のみ。

export interface OsaraiPromptContext {
  /** 埋めたい顧客カードのスキーマ説明 */
  schema: string;
  /** 対象顧客の既存データ（JSON文字列）。新規なら 'なし' */
  customerJson: string;
  /** これまでの対話履歴（整形済みテキスト） */
  history: string;
}

export const OSARAI_SYSTEM_PROMPT = `あなたは「おさらい」のAIインタビュアー。ユーザーが人と会ったあと、
記憶が新しいうちに会話で振り返りを促し、顧客情報を整理する。
- フォームを埋めさせない。1問ずつ、自然に、短く聞く。
- 既存データがあれば差分・進展を聞く（同じことを聞かない）。
- ユーザーの発話から下記スキーマを抽出: {points, needs, temperature, next_actions, custom_fields}
- points は「営業に関係ありそうな要点」だけに絞らない。雑談で出てきた具体的な出来事・個人的な変化・
  近況の断片（例:「4年ぶりに彼氏ができた」「子供が受験を控えている」）も、一見重要度が低そうでも
  そのまま拾って含める。ユーザー本人が「言った」ことは基本的に記録価値があるものとして扱う。
- 重要項目が埋まったら done=true。
- next_question（ユーザーへの発話）は、親しみやすさが伝わるよう適度に絵文字を1つ程度
  添えてよい（例: 😊 🎉 ☕️）。ただし多用しない（1メッセージにつき0〜1個・無理に付けない）。
- 出力は必ずJSONのみ（{extracted, next_question, done}）。`;

export function buildOsaraiPrompt(ctx: OsaraiPromptContext): string {
  return [
    OSARAI_SYSTEM_PROMPT,
    `顧客スキーマ: ${ctx.schema}`,
    `既存データ: ${ctx.customerJson}`,
    `対話履歴: ${ctx.history}`,
  ].join('\n');
}
