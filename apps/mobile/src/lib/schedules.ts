// スケジュール（アポ・予定）のデータアクセス（RLSがowner_idスコープを担保）。
import { supabase } from './supabase.js';
import type { Database } from '@osarai/shared/database.types';
import type { Profile } from './db.js';
import { recomputeCustomerTemperature } from './db.js';

export type Schedule = Database['public']['Tables']['schedules']['Row'];

// カテゴリは汎用の固定リスト(select)から選ぶ想定だが、DBはtext(自由記述可)。
export const SCHEDULE_CATEGORIES = ['アポ', '商談', '会議', '私用', 'その他'] as const;

// 対面/オンラインの区分。category同様、将来の選択肢追加を考慮しCHECK制約は設けずtext。
export const SCHEDULE_MODES = ['対面', 'オンライン'] as const;

export interface ScheduleInput {
  title: string;
  customerId: string | null;
  category: string | null;
  startAt: string; // ISO
  endAt: string; // ISO
  notes: string | null;
  mode: string | null;
  location: string | null;
}

export async function listSchedules(range: { from: string; to: string }): Promise<Schedule[]> {
  // 日を跨ぐ予定(例: 前日23:00〜当日1:00)は開始時刻がrange.fromより前になり得るため、
  // start_atだけでなく「期間と重なるか」(overlap: start_at < to && end_at > from)で
  // 絞り込む(バグ修正: 従来はstart_atのみで絞っており、日を跨いで開始した予定が
  // 表示範囲から丸ごと欠落していた)。
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .lt('start_at', range.to)
    .gt('end_at', range.from)
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
      notes: input.notes,
      mode: input.mode,
      location: input.location,
    })
    .select()
    .single();
  if (error) throw error;
  // アポ履歴(予定件数)が温度感の算出要素のため、予定に紐づく顧客がいれば再計算する。
  if (input.customerId) await recomputeCustomerTemperature(input.customerId);
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
      notes: input.notes,
      mode: input.mode,
      location: input.location,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
  if (input.customerId) await recomputeCustomerTemperature(input.customerId);
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.from('schedules').delete().eq('id', id);
  if (error) throw error;
}

// 場所の入力履歴(議事録要望「ユーザーごとに履歴を残し次回以降選択できるように」)。
// 履歴専用テーブルは設けず、自分の過去の予定から場所を新しい順に重複除去して返す簡易実装。
// owner_idを明示フィルタする(RLSはleaderに他メンバー分の閲覧も許すため、ここでは
// 「自分の」履歴に厳密に絞る)。
export async function listLocationHistory(limit = 20): Promise<string[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('schedules')
    .select('location')
    .eq('owner_id', user.id)
    .not('location', 'is', null)
    .order('start_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const seen = new Set<string>();
  const history: string[] = [];
  for (const row of (data as { location: string | null }[]) ?? []) {
    const loc = row.location?.trim();
    if (loc && !seen.has(loc)) {
      seen.add(loc);
      history.push(loc);
      if (history.length >= limit) break;
    }
  }
  return history;
}

// ========== 日程調整文章生成（議事録『review』人力回答A寄り・再作成） ==========
// 自分の既存予定から空いている時間帯(候補日時)を探し、コピー/その場で編集してLINE等で
// 送れる文章を生成する。AIは使わず、既存スケジュールデータからの純粋な計算(低コスト・低リスク)。

export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 19;
const SLOT_HOURS = 1;
const MAX_CANDIDATES = 3;
export const SEARCH_DAYS = 7;

export interface FreeSlot {
  start: Date;
  end: Date;
}

export interface FindFreeSlotsOptions {
  /** 検索開始オフセット(日数。0=今日から・1=明日から等) */
  startOffsetDays?: number;
  /** 検索日数 */
  days?: number;
  /** 対象の時間範囲(時) */
  startHour?: number;
  endHour?: number;
}

// 平日(月〜金)・指定の時間範囲内で、既存予定と重ならない1時間枠を探す。
// 指定の日付範囲から最大3件、日をなるべく分散させて選ぶ。
export function findFreeSlots(existing: Schedule[], now: Date = new Date(), opts: FindFreeSlotsOptions = {}): FreeSlot[] {
  const startOffsetDays = opts.startOffsetDays ?? 0;
  const days = opts.days && opts.days > 0 ? opts.days : SEARCH_DAYS;
  const startHour = opts.startHour ?? BUSINESS_START_HOUR;
  const endHour = opts.endHour ?? BUSINESS_END_HOUR;

  const busy = existing
    .map((s) => ({ start: new Date(s.start_at), end: new Date(s.end_at) }))
    .sort((a, b) => +a.start - +b.start);

  const candidates: FreeSlot[] = [];
  for (
    let dayOffset = startOffsetDays;
    dayOffset < startOffsetDays + days && candidates.length < MAX_CANDIDATES;
    dayOffset++
  ) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    if (day.getDay() === 0 || day.getDay() === 6) continue; // 平日のみ

    let foundOnThisDay = false;
    for (let hour = startHour; hour + SLOT_HOURS <= endHour; hour++) {
      const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
      const slotEnd = new Date(slotStart.getTime() + SLOT_HOURS * 60 * 60 * 1000);
      if (slotStart < now) continue; // 過去の時間帯は候補にしない
      const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);
      if (!overlaps) {
        candidates.push({ start: slotStart, end: slotEnd });
        foundOnThisDay = true;
        break; // 1日1候補に留めて日をなるべく分散させる
      }
    }
    if (!foundOnThisDay) continue;
  }
  return candidates;
}

// ---- デフォルト設定(日付範囲/時間範囲)の保存・読み込み ----
// profiles.user_profile(jsonb)の schedule_proposal_defaults キーに保存する。
// Settings.tsx等の他画面が管理する項目を壊さないよう、既存値の全体上書きではなく
// merge_user_profile_fields(0013・アトミックなjsonbマージRPC)経由でこのキーだけを更新する。
export interface ScheduleProposalSettings {
  startOffsetDays: number;
  days: number;
  startHour: number;
  endHour: number;
}

export const DEFAULT_PROPOSAL_SETTINGS: ScheduleProposalSettings = {
  startOffsetDays: 0,
  days: SEARCH_DAYS,
  startHour: BUSINESS_START_HOUR,
  endHour: BUSINESS_END_HOUR,
};

export function proposalSettingsFromUserProfile(userProfile: unknown): ScheduleProposalSettings {
  const raw = (userProfile as Record<string, unknown> | null | undefined)?.schedule_proposal_defaults as
    | Partial<ScheduleProposalSettings>
    | undefined;
  return {
    startOffsetDays: typeof raw?.startOffsetDays === 'number' ? raw.startOffsetDays : DEFAULT_PROPOSAL_SETTINGS.startOffsetDays,
    days: typeof raw?.days === 'number' && raw.days > 0 ? raw.days : DEFAULT_PROPOSAL_SETTINGS.days,
    startHour: typeof raw?.startHour === 'number' ? raw.startHour : DEFAULT_PROPOSAL_SETTINGS.startHour,
    endHour: typeof raw?.endHour === 'number' ? raw.endHour : DEFAULT_PROPOSAL_SETTINGS.endHour,
  };
}

export async function saveProposalDefaults(settings: ScheduleProposalSettings): Promise<void> {
  const { error } = await supabase.rpc('merge_user_profile_fields', {
    new_notes: [],
    new_fields: { schedule_proposal_defaults: settings } as never,
  });
  if (error) throw error;
}

export function formatScheduleProposalText(slots: FreeSlot[]): string {
  if (slots.length === 0) {
    return '指定した期間・時間帯で空いている候補が見つかりませんでした。日付範囲や時間範囲を変えてもう一度お試しください。';
  }
  const lines = slots.map((s) => {
    const dateLabel = s.start.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    const timeLabel = `${s.start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}〜${s.end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
    return `・${dateLabel} ${timeLabel}`;
  });
  return `以下の日程でご都合いかがでしょうか？\n\n${lines.join('\n')}\n\nご都合の良い日時があればお知らせください。`;
}
