// 法務ページ（利用規約・プライバシーポリシー・特定商取引法に基づく表記）の下書きガード（2026-09-28）。
// 下書きには「【要記入」の穴埋めが残っている。本番（Vercel production）では、穴埋めが1つでも
// 残っているページは公開しない（書きかけの法務文書を出さない）。ローカルやプレビューでは確認用に表示する。
export const PLACEHOLDER = '【要記入';

export function isProduction(): boolean {
  // サーバーでは VERCEL_ENV、ブラウザ側（'use client' の画面）では Vercel が自動で渡す NEXT_PUBLIC_VERCEL_ENV を見る
  return (process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV) === 'production';
}

/** 本文に穴埋めが残っているか（文字列を連結して渡す） */
export function hasPlaceholder(...texts: string[]): boolean {
  return texts.some((t) => t.includes(PLACEHOLDER));
}

/**
 * 法務ページの穴埋め（運営者の情報など）。ここを埋めると、利用規約の改定版・プライバシーポリシー・
 * 特定商取引法に基づく表記が本番で公開され、LP や申し込み画面からのリンクも出る。
 */
export const LEGAL = {
  operator: '【要記入: 運営者の屋号または法人名】',
  manager: '【要記入: 運営統括責任者の氏名】',
  email: '【要記入: お問い合わせ用メールアドレス】',
  // 個人事業の場合は「ご請求があれば遅滞なく開示します」と書く方法がある（消費者庁の運用）
  address: '【要記入: 所在地（個人事業の場合は「ご請求があれば遅滞なく開示します」でも可）】',
  phone: '【要記入: 電話番号（個人事業の場合は「ご請求があれば遅滞なく開示します」でも可）】',
  priceTax: '【要記入: 価格が税込か税抜か（例: 税込）】',
  termsEffective: '【要記入: 利用規約の施行日（例: 2026年10月1日）】',
  privacyEnacted: '【要記入: プライバシーポリシーの制定日（例: 2026年10月1日）】',
  court: '【要記入: 合意管轄の裁判所（例: 東京地方裁判所）】',
  // Gemini API を有料枠で使っている場合は「AI の学習に利用されない」旨を書ける（Google の利用条件による）
  geminiTraining: '【要記入: Gemini API の利用枠（有料枠なら「送信したデータが Google の AI の学習に利用されない条件で利用しています」）】',
  audioRetention: '【要記入: 録音音声の保存期間（例: 解析が完了してから30日後に自動で削除します）】',
} as const;

/** 法務ページがすべて公開できる状態か（穴埋めが残っていない） */
export function legalReady(): boolean {
  return !hasPlaceholder(...Object.values(LEGAL));
}

/** 法務ページへのリンクを出してよいか（本番では穴埋めが全部済んでから） */
export function showLegalLinks(): boolean {
  return !isProduction() || legalReady();
}
