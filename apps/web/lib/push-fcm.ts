// FCM 送信ヘルパー（§12・サーバー専用）。おさらい促し通知を配信。
// FCM_SERVER_KEY（サーバーキー）で HTTP レガシー送信。
// ※未設定なら送らず notConfigured を返す。APNs は FCM 経由（iOSトークンもFCM登録）想定。
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

export interface PushResult {
  configured: boolean;
  sent: number;
  failed: number;
}

export async function sendPush(
  tokens: string[],
  notification: { title: string; body: string; data?: Record<string, string> },
): Promise<PushResult> {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return { configured: false, sent: 0, failed: 0 };
  if (tokens.length === 0) return { configured: true, sent: 0, failed: 0 };

  const res = await fetch(FCM_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `key=${key}` },
    body: JSON.stringify({
      registration_ids: tokens,
      notification: { title: notification.title, body: notification.body },
      data: notification.data ?? {},
    }),
  });
  if (!res.ok) return { configured: true, sent: 0, failed: tokens.length };
  const json = (await res.json().catch(() => ({}))) as { success?: number; failure?: number };
  return { configured: true, sent: json.success ?? 0, failed: json.failure ?? tokens.length };
}
