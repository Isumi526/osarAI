// スケジュール（アポ・予定）のデータアクセス（RLSがowner_idスコープを担保）。
import { supabase } from './supabase.js';
import type { Database } from '@osarai/shared/database.types';
import type { Profile } from './db.js';

export type Schedule = Database['public']['Tables']['schedules']['Row'];

// カテゴリは汎用の固定リスト(select)から選ぶ想定だが、DBはtext(自由記述可)。
export const SCHEDULE_CATEGORIES = ['アポ', '会議', '私用', 'その他'] as const;

export interface ScheduleInput {
  title: string;
  customerId: string | null;
  category: string | null;
  startAt: string; // ISO
  endAt: string; // ISO
}

export async function listSchedules(range: { from: string; to: string }): Promise<Schedule[]> {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .gte('start_at', range.from)
    .lt('start_at', range.to)
    .order('start_at', { ascending: true });
  if (error) throw error;
  return (data as Schedule[]) ?? [];
}

export async function createSchedule(
  input: ScheduleInput,
  profile: Pick<Profile, 'id' | 'org_id'>,
): Promise<Schedule> {
  const { data, error } = await supabase
    .from('schedules')
    .insert({
      org_id: profile.org_id,
      owner_id: profile.id,
      customer_id: input.customerId,
      title: input.title,
      category: input.category,
      start_at: input.startAt,
      end_at: input.endAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Schedule;
}

export async function updateSchedule(id: string, input: ScheduleInput): Promise<void> {
  const { error } = await supabase
    .from('schedules')
    .update({
      customer_id: input.customerId,
      title: input.title,
      category: input.category,
      start_at: input.startAt,
      end_at: input.endAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('id', id);
  if (error) throw error;
}
