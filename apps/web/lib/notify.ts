// 通知の配信口（2026-09-27）。アプリ内通知（ベル）に必ず残し、プッシュ用トークンがあれば push も送る。
// プッシュはネイティブアプリ（Capacitor）でしか届かず、Web アプリ（PWA）の利用者にはベルが実質の窓口に
// なるため、両方に同じ内容を出す。呼び出し側は service_role のクライアントを渡す（システムジョブ）。
import { sendPush } from '@/lib/push-fcm';
import type { SB } from '@/lib/customer-context';

export interface NotifyInput {
  userId: string;
  orgId: string;
  title: string;
  body: string;
  /** 通知を押した時に開くアプリ内のパス（外部URLは入れない） */
  linkPath: string;
  customerId?: string | null;
  taskId?: string | null;
}

export async function notifyUser(db: SB, n: NotifyInput): Promise<{ inApp: boolean; pushSent: number; pushConfigured: boolean }> {
  const { error } = await db.from('notifications').insert({
    org_id: n.orgId,
    user_id: n.userId,
    category: 'reminder',
    title: n.title,
    body: n.body,
    link_path: n.linkPath,
    customer_id: n.customerId ?? null,
    task_id: n.taskId ?? null,
  });
  const { data: tokenRows } = await db.from('push_tokens').select('token').eq('user_id', n.userId);
  const tokens = (tokenRows ?? []).map((t) => t.token);
  const push = await sendPush(tokens, { title: n.title, body: n.body, data: { path: n.linkPath } });
  return { inApp: !error, pushSent: push.sent, pushConfigured: push.configured };
}

/** 契約中（trialing/active）のユーザーと、その所属組織。 */
export async function activeUsers(db: SB): Promise<{ userId: string; orgId: string }[]> {
  const { data: subs } = await db.from('subscriptions').select('user_id').in('status', ['trialing', 'active']);
  const ids = (subs ?? []).map((s) => s.user_id);
  if (ids.length === 0) return [];
  const { data: profiles } = await db.from('profiles').select('id, org_id').in('id', ids);
  return (profiles ?? []).map((p) => ({ userId: p.id, orgId: p.org_id }));
}
