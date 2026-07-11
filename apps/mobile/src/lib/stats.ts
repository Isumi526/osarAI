// 個人の集計（今月/累計のアポ数・おさらい数）。リーダー集約(F-05)とは別の
// 個人利用者向け軽量な自己集計。RLS(schedules_select/interactions_select)が
// 自分の分のみにスコープする。
import { supabase } from './supabase.js';
import { jstMonthStartUtc } from '@osarai/shared';

export interface PersonalStats {
  monthAppointments: number;
  monthOsarai: number;
  totalAppointments: number;
  totalOsarai: number;
  upcomingSchedules: number; // 今後(現在時刻以降)の予定件数。議事録『review(2回目)』要望の予定集計。
  monthNewCustomers: number; // 今月新規登録した顧客数
  totalCustomers: number; // 累計顧客数(archiveされていないもの)
}

export async function getPersonalStats(): Promise<PersonalStats> {
  const monthStart = jstMonthStartUtc().toISOString();
  const now = new Date().toISOString();

  const [
    monthAppointments,
    monthOsarai,
    totalAppointments,
    totalOsarai,
    upcomingSchedules,
    monthNewCustomers,
    totalCustomers,
  ] = await Promise.all([
    supabase.from('schedules').select('id', { count: 'exact', head: true }).gte('start_at', monthStart),
    supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'ai_dialogue')
      .gte('met_at', monthStart),
    supabase.from('schedules').select('id', { count: 'exact', head: true }),
    supabase.from('interactions').select('id', { count: 'exact', head: true }).eq('source', 'ai_dialogue'),
    supabase.from('schedules').select('id', { count: 'exact', head: true }).gte('start_at', now),
    supabase.from('customers').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('status', 'active'),
  ]);

  return {
    monthAppointments: monthAppointments.count ?? 0,
    monthOsarai: monthOsarai.count ?? 0,
    totalAppointments: totalAppointments.count ?? 0,
    totalOsarai: totalOsarai.count ?? 0,
    upcomingSchedules: upcomingSchedules.count ?? 0,
    monthNewCustomers: monthNewCustomers.count ?? 0,
    totalCustomers: totalCustomers.count ?? 0,
  };
}
