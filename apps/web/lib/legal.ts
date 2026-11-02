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
  operator: 'Stism 亥角 貴治',
  manager: '亥角 貴治',
  email: 'support@osarai.app',
  // 個人事業の場合は「ご請求があれば遅滞なく開示します」と書く方法がある（消費者庁の運用）
  address: 'ご請求があれば遅滞なく開示します',
  phone: 'ご請求があれば遅滞なく開示します',
  priceTax: '税込',
  termsEffective: '【要記入: 利用規約の施行日（例: 2026年10月1日）】',
  privacyEnacted: '【要記入: プライバシーポリシーの制定日（例: 2026年10月1日）】',
  // 運営者の住所地（大阪）の地方裁判所。利用者の多くが事業者なので専属的合意管轄として置く
  court: '大阪地方裁判所',
  // Gemini API を有料枠で使っている場合は「AI の学習に利用されない」旨を書ける（Google の利用条件による）
  geminiTraining: '【要記入: Gemini API の利用枠（有料枠なら「送信したデータが Google の AI の学習に利用されない条件で利用しています」）】',
  audioRetention: '録音音声は、ご契約中は保存し、ご利用者が会議ごとにいつでも削除できます。解約後は90日を経過した時点で自動で削除し、退会された場合はただちに削除します。',
} as const;

/** 法務ページがすべて公開できる状態か（穴埋めが残っていない） */
export function legalReady(): boolean {
  return !hasPlaceholder(...Object.values(LEGAL));
}

/** 法務ページへのリンクを出してよいか（本番では穴埋めが全部済んでから） */
export function showLegalLinks(): boolean {
  return !isProduction() || legalReady();
}
