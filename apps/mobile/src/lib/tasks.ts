// タスクのCRUD（2026-08-06 UI/UX刷新）。lib/schedules.ts と同じ supabase 直アクセスパターン。
// AIチャットからの登録はサーバー側(assistant/commit)が行い、ここは一覧画面の手動操作用。
import { supabase } from './supabase.js';
import { getMyProfile } from './db.js';

export interface Task {
  id: string;
  org_id: string;
  owner_id: string;
  customer_id: string | null;
  title: string;
  due_at: string | null;
  status: 'open' | 'done';
  completed_at: string | null;
  source: 'manual' | 'assistant';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  title: string;
  dueAt?: string | null;
  customerId?: string | null;
  notes?: string | null;
}

export async function listTasks(opts: { status?: 'open' | 'done' } = {}): Promise<Task[]> {
  let q = supabase.from('tasks').select('*');
  if (opts.status) q = q.eq('status', opts.status);
  // 期限の近い順。期限なしは末尾に回す（nullsFirst: false）。
  const { data, error } = await q
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Task[]) ?? [];
}

export async function createTask(input: TaskInput): Promise<Task> {
  const profile = await getMyProfile();
  if (!profile) throw new Error('プロフィールが取得できませんでした');
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      org_id: profile.org_id,
      owner_id: profile.id,
      title: input.title,
      due_at: input.dueAt ?? null,
      customer_id: input.customerId ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Task;
}

export async function updateTask(id: string, input: Partial<TaskInput>): Promise<void> {
  const patch: {
    updated_at: string;
    title?: string;
    due_at?: string | null;
    customer_id?: string | null;
    notes?: string | null;
  } = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.dueAt !== undefined) patch.due_at = input.dueAt;
  if (input.customerId !== undefined) patch.customer_id = input.customerId;
  if (input.notes !== undefined) patch.notes = input.notes;
  const { error } = await supabase.from('tasks').update(patch).eq('id', id);
  if (error) throw error;
}

/** 完了/未完了の切り替え。status と completed_at を必ず同時に更新する（片方だけ残さない）。 */
export async function toggleTaskDone(id: string, done: boolean): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('tasks')
    .update({ status: done ? 'done' : 'open', completed_at: done ? now : null, updated_at: now })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw error;
}
