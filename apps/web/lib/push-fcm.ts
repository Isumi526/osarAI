// FCM 送信ヘルパー（§12・サーバー専用）。おさらい促し通知を配信。
// FCM HTTP v1（サービスアカウント + OAuth2）を使用。
// ※レガシー(server key / fcm/send)は2024年に廃止のため v1 のみ対応。
// 認証情報は FCM_SERVICE_ACCOUNT（サービスアカウントJSON文字列 or base64）で渡す。
import crypto from 'node:crypto';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface PushResult {
  configured: boolean;
  sent: number;
  failed: number;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // base64 でも生JSONでも受ける
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(json) as ServiceAccount;
    if (!sa.project_id || !sa.client_email || !sa.private_key) return null;
    // .env に \n エスケープで入っている場合を復元
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch {
    return null;
  }
}

// アクセストークンは有効期限までモジュール内にキャッシュ
let cachedToken: { token: string; exp: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(sa.private_key)
    .toString('base64url');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`FCM oauth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, exp: now + j.expires_in };
  return j.access_token;
}

/** 複数トークンへ通知を送る。HTTP v1 は 1リクエスト1トークンなので順次送信。 */
export async function sendPush(
  tokens: string[],
  notification: { title: string; body: string; data?: Record<string, string> },
): Promise<PushResult> {
  const sa = loadServiceAccount();
  if (!sa) return { configured: false, sent: 0, failed: 0 };
  if (tokens.length === 0) return { configured: true, sent: 0, failed: 0 };

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch {
    return { configured: true, sent: 0, failed: tokens.length };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  let failed = 0;
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: notification.title, body: notification.body },
              data: notification.data ?? {},
            },
          }),
        });
        if (res.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }),
  );
  return { configured: true, sent, failed };
}

function base64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}
