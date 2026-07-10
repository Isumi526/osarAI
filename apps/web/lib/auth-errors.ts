// Supabase/認証まわりの英語エラーメッセージを日本語に変換する。
// 既知のメッセージはマッピング、未知は汎用日本語にフォールバック。
const MAP: { match: RegExp; ja: string }[] = [
  { match: /invalid login credentials/i, ja: 'メールアドレスまたはパスワードが正しくありません。' },
  { match: /email not confirmed/i, ja: 'メールアドレスの確認が完了していません。確認メールのリンクを開いてください。' },
  { match: /user already registered|already been registered/i, ja: 'このメールアドレスは既に登録されています。' },
  { match: /password should be at least/i, ja: 'パスワードは8文字以上で入力してください。' },
  { match: /unable to validate email address|invalid email/i, ja: 'メールアドレスの形式が正しくありません。' },
  { match: /rate limit|too many requests/i, ja: '試行回数が多すぎます。しばらく待ってから再度お試しください。' },
  { match: /network|failed to fetch/i, ja: '通信エラーが発生しました。ネットワークを確認して再度お試しください。' },
  { match: /signups? not allowed|signup is disabled/i, ja: '現在、新規登録を受け付けていません。' },
];

export function toJaAuthError(message: string | undefined | null): string {
  if (!message) return 'エラーが発生しました。時間をおいて再度お試しください。';
  for (const { match, ja } of MAP) {
    if (match.test(message)) return ja;
  }
  return 'エラーが発生しました。時間をおいて再度お試しください。';
}
