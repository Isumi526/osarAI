// 運営者向け人間通知（LINE・scripts/notify-humanball.mjs と同一契約）。
// webhookハンドラ(サーバーレス関数)からは子プロセスを起動できないため、
// 同じ Google Apps Script Webhook へ直接POSTする形で契約を再実装している。
// best-effort: 失敗しても呼び出し元の処理(DB更新等)は止めない。
export async function notifyOperator(params: { kind: string; task: string; detail: string }): Promise<void> {
  const url = process.env.HUMANBALL_WEBHOOK_URL;
  if (!url) return; // 未設定なら何もしない（best-effort）

  const secret = process.env.HUMANBALL_WEBHOOK_SECRET ?? '';
  const prefix = (process.env.NOTIFY_PREFIX ?? '').trim();
  const project = (process.env.NOTIFY_PROJECT ?? 'project').trim();
  const rawTask = params.task;
  const task = prefix && !rawTask.startsWith(prefix) ? `${prefix} ${rawTask}` : rawTask;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        secret,
        kind: params.kind,
        task,
        detail: params.detail,
        url: 'https://claude.ai/code',
      }),
    });
  } catch {
    // best-effort: 通知失敗は握りつぶす（呼び出し元の本処理をブロックしない）
  }
}
