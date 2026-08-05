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
// 空き時間帯として提示する最小の長さ。予定と予定の隙間が短すぎる場合は候補にしない。
const MIN_FREE_MINUTES = 30;
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
  /** 対象の時間範囲の分(0-59)。19:30のような指定に対応する。未指定は0分 */
  startMinute?: number;
  endMinute?: number;
  /** 候補に入れる曜日(0=日〜6=土)。未指定なら平日(月〜金) */
  weekdays?: number[];
}

/** 曜日の既定値: 平日(月〜金)。土日を含めたい場合は設定で選ぶ */
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 平日(月〜金)・指定の時間範囲内で、既存予定と重ならない「空き時間帯」を日ごとに求める。
// 指定した日付範囲の全日を対象にし、1時間などの固定枠には切らず、空いている範囲を
// そのまま返す（例: 13:00〜19:00。途中に予定があれば 13:00〜15:00 と 16:30〜19:00 に分割）。
// 人力レビュー(2026-08-05)で「3件・各1時間枠しか出ない」ため実用に足りないと指摘され、
// 件数上限(旧MAX_CANDIDATES=3)と1時間固定枠(旧SLOT_HOURS)を撤廃した。
export function findFreeSlots(existing: Schedule[], now: Date = new Date(), opts: FindFreeSlotsOptions = {}): FreeSlot[] {
  const startOffsetDays = opts.startOffsetDays ?? 0;
  const days = opts.days && opts.days > 0 ? opts.days : SEARCH_DAYS;
  const startHour = opts.startHour ?? BUSINESS_START_HOUR;
  const endHour = opts.endHour ?? BUSINESS_END_HOUR;
  const startMinute = opts.startMinute ?? 0;
  const endMinute = opts.endMinute ?? 0;
  const weekdays = opts.weekdays && opts.weekdays.length > 0 ? opts.weekdays : DEFAULT_WEEKDAYS;
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) return [];

  const busy = existing
    .map((s) => ({ start: new Date(s.start_at), end: new Date(s.end_at) }))
    .sort((a, b) => +a.start - +b.start);

  const freeSlots: FreeSlot[] = [];
  for (let dayOffset = startOffsetDays; dayOffset < startOffsetDays + days; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    if (!weekdays.includes(day.getDay())) continue; // 選択された曜日のみ

    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startMinute, 0, 0);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour, endMinute, 0, 0);
    // 今日ぶんは既に過ぎた時間を除く
    let cursor = dayStart < now ? new Date(now) : dayStart;
    if (cursor >= dayEnd) continue;

    // その日の予定で埋まっている区間を順に取り除き、残った区間を空き時間帯として拾う
    for (const b of busy) {
      if (b.end <= cursor || b.start >= dayEnd) continue;
      if (b.start > cursor) pushIfLongEnough(freeSlots, cursor, b.start);
      if (b.end > cursor) cursor = new Date(b.end);
      if (cursor >= dayEnd) break;
    }
    if (cursor < dayEnd) pushIfLongEnough(freeSlots, cursor, dayEnd);
  }
  return freeSlots;
}

function pushIfLongEnough(out: FreeSlot[], start: Date, end: Date): void {
  if (+end - +start >= MIN_FREE_MINUTES * 60 * 1000) out.push({ start, end });
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
  /** 時間範囲の分(0-59)。19:30のような指定に対応する */
  startMinute: number;
  endMinute: number;
  /** 候補に入れる曜日(0=日〜6=土) */
  weekdays: number[];
  /** 候補一覧の前に置く導入文（空にすると導入文なしで候補から始まる） */
  introText: string;
}

/** 導入文の既定。締めの定型文は付けない（人力レビュー2026-08-05で不要と判断） */
export const DEFAULT_PROPOSAL_INTRO = '以下の日程でご都合いかがでしょうか？';

export const DEFAULT_PROPOSAL_SETTINGS: ScheduleProposalSettings = {
  // 既定は「明日から」。当日は残り時間が少なく候補として提示しづらいため（人力レビュー2026-08-05）
  startOffsetDays: 1,
  days: SEARCH_DAYS,
  startHour: BUSINESS_START_HOUR,
  endHour: BUSINESS_END_HOUR,
  startMinute: 0,
  endMinute: 0,
  weekdays: DEFAULT_WEEKDAYS,
  introText: DEFAULT_PROPOSAL_INTRO,
};

// ---- 日付範囲(カレンダー選択)と相対オフセットの相互変換 ----
// UIはカレンダー(input[type=date])で開始日・終了日を選ぶが、デフォルトとして保存するのは
// 絶対日付ではなく「今日からの相対日数」。こうすると後日開き直した時も、その日を基準に
// 同じ長さの期間が自動でセットされる（日付が過去に固定されない・人力レビュー2026-08-05）。
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 今日+offset日 を input[type=date] 用の "YYYY-MM-DD" にする */
export function offsetToDateInputValue(offsetDays: number, now: Date = new Date()): string {
  const d = startOfLocalDay(now);
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" を今日からの相対日数にする（不正値は fallback を返す） */
export function dateInputValueToOffset(value: string, fallback: number, now: Date = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return fallback;
  const picked = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(+picked)) return fallback;
  return Math.round((+startOfLocalDay(picked) - +startOfLocalDay(now)) / (24 * 60 * 60 * 1000));
}

/** 相対日数を「今日/明日/明後日/N日後」の表示ラベルにする（値は実日付・表示だけ相対） */
export function relativeDayLabel(offsetDays: number): string {
  if (offsetDays === 0) return '今日';
  if (offsetDays === 1) return '明日';
  if (offsetDays === 2) return '明後日';
  if (offsetDays < 0) return `${-offsetDays}日前`;
  return `${offsetDays}日後`;
}

/** 設定の時刻を input[type=time] 用の "HH:MM" にする */
export function toTimeInputValue(hour: number, minute: number): string {
  const h = Math.min(23, Math.max(0, Math.floor(hour)));
  const m = Math.min(59, Math.max(0, Math.floor(minute)));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** input[type=time] の "HH:MM" を時・分に分解する（不正値は既定へフォールバック） */
export function parseTimeInputValue(value: string, fallbackHour: number, fallbackMinute: number): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return { hour: fallbackHour, minute: fallbackMinute };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }
  return { hour, minute };
}

export function proposalSettingsFromUserProfile(userProfile: unknown): ScheduleProposalSettings {
  const raw = (userProfile as Record<string, unknown> | null | undefined)?.schedule_proposal_defaults as
    | Partial<ScheduleProposalSettings>
    | undefined;
  return {
    startOffsetDays: typeof raw?.startOffsetDays === 'number' ? raw.startOffsetDays : DEFAULT_PROPOSAL_SETTINGS.startOffsetDays,
    days: typeof raw?.days === 'number' && raw.days > 0 ? raw.days : DEFAULT_PROPOSAL_SETTINGS.days,
    startHour: typeof raw?.startHour === 'number' ? raw.startHour : DEFAULT_PROPOSAL_SETTINGS.startHour,
    endHour: typeof raw?.endHour === 'number' ? raw.endHour : DEFAULT_PROPOSAL_SETTINGS.endHour,
    // 分は後から追加した項目のため、分を持たない保存済みデフォルトは0分として扱う
    startMinute: typeof raw?.startMinute === 'number' ? raw.startMinute : DEFAULT_PROPOSAL_SETTINGS.startMinute,
    endMinute: typeof raw?.endMinute === 'number' ? raw.endMinute : DEFAULT_PROPOSAL_SETTINGS.endMinute,
    // 導入文も後から追加。未保存なら既定文。意図的に空にした場合は空のまま尊重する
    introText: typeof raw?.introText === 'string' ? raw.introText : DEFAULT_PROPOSAL_SETTINGS.introText,
    // 保存済みデフォルトが無い/壊れている場合は平日既定に戻す（全曜日オフでの空振りも防ぐ）
    weekdays:
      Array.isArray(raw?.weekdays) && raw.weekdays.some((d) => typeof d === 'number')
        ? raw.weekdays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
        : DEFAULT_PROPOSAL_SETTINGS.weekdays,
  };
}

export async function saveProposalDefaults(settings: ScheduleProposalSettings): Promise<void> {
  const { error } = await supabase.rpc('merge_user_profile_fields', {
    new_notes: [],
    new_fields: { schedule_proposal_defaults: settings } as never,
  });
  if (error) throw error;
}

export function formatScheduleProposalText(slots: FreeSlot[], introText?: string): string {
  if (slots.length === 0) {
    return '指定した期間・時間帯で空いている候補が見つかりませんでした。日付範囲や時間範囲を変えてもう一度お試しください。';
  }
  // 同じ日の空き時間帯は1行にまとめる（例: ・8月6日(木) 13:00〜15:00 / 16:30〜19:00）
  const byDay = new Map<string, { label: string; times: string[] }>();
  for (const s of slots) {
    const key = s.start.toDateString();
    const dateLabel = s.start.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    const timeLabel = `${s.start.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}〜${s.end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
    const entry = byDay.get(key) ?? { label: dateLabel, times: [] };
    entry.times.push(timeLabel);
    byDay.set(key, entry);
  }
  const lines = [...byDay.values()].map((d) => `・${d.label} ${d.times.join(' / ')}`);
  const intro = (introText ?? DEFAULT_PROPOSAL_INTRO).trim();
  const head = intro ? `${intro}\n\n` : '';
  return `${head}${lines.join('\n')}`;
}
