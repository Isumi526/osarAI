// アプリ内通知の読み出し（2026-09-08）。
// 作成はサーバー(service_role)側のみ＝クライアントから「お知らせ」を偽装できないようにするため、
// ここには insert を置かない（RLSも select/update のみ許可・migration 0029）。
import { supabase } from './supabase.js';

/** 通知のカテゴリ。announce=運営からのお知らせ / reminder=約束・予定・タスク期限 */
export type NotificationCategory = 'announce' | 'reminder';

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  link_path: string | null;
  read_at: string | null;
  created_at: string;
}

/** 指定カテゴリの通知を新しい順に取得する */
export async function listNotifications(category: NotificationCategory, limit = 50): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, category, title, body, link_path, read_at, created_at')
    .eq('category', category)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AppNotification[];
}

/** 未読件数（ベルのバッジ用・カテゴリ問わず） */
export async function countUnread(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** 既読にする（開いた通知だけ・一覧を開いただけで全部既読にはしない） */
export async function markRead(id: string): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

/** そのカテゴリの未読をまとめて既読にする */
export async function markAllRead(category: NotificationCategory): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('category', category)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}
