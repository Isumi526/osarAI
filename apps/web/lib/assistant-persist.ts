// 統合AIチャット（2026-08-06 UI/UX刷新）の永続化。
// 誤登録防止のため、AIに保存させず「ユーザーが確認カードで編集した最終版」をここで
// 決定的に書き込む（/api/assistant/commit から呼ぶ）。
// 既存 osarai/turn の persistOnDone と同じ規律（custom_fieldsはマージRPC・温度感再計算・
// interactions(source='ai_dialogue')作成）を踏襲し、Homeの個人集計との互換を保つ。
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@osarai/shared/database.types';
import { computeAutoTemperature, type AiSummary } from '@osarai/shared';

type DB = SupabaseClient<Database>;

export interface PersonProposal {
  customer_id: string | null;
  name: string;
  points?: string[];
  needs?: string[];
  next_actions?: string[];
  custom_fields?: Record<string, unknown>;
}

export interface ScheduleProposal {
  title: string;
  start_at: string;
  end_at: string;
  person_index: number | null;
  location?: string | null;
  mode?: string | null;
  category?: string | null;
}

export interface TaskProposal {
  title: string;
  due_at: string | null;
  person_index: number | null;
}

export interface Proposals {
  people: PersonProposal[];
  schedules: ScheduleProposal[];
  tasks: TaskProposal[];
  self_notes?: string[];
  self_fields?: Record<string, string>;
}

export interface CommitResult {
  customers: { id: string; name: string; isNew: boolean }[];
  interactionIds: string[];
  scheduleIds: string[];
  taskIds: string[];
}

/** 表記揺れの検知用。全角半角・敬称・空白を落とした比較キーにする。 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '')
    .toLowerCase();
}

export async function commitProposals(args: {
  supabase: DB;
  orgId: string;
  userId: string;
  proposals: Proposals;
  transcript: string;
  /** 会議の議事録（T3）。あれば主たる相手の履歴(interaction)に残してタイムラインで読めるようにする。 */
  minutes?: string | null;
}): Promise<CommitResult> {
  const { supabase, orgId, userId, proposals, transcript, minutes } = args;
  const now = new Date().toISOString();
  let minutesAttached = false;

  // 既存つながりを一度だけ引き、新規作成時の重複（表記揺れ）を防ぐ照合に使う。
  const { data: existing } = await supabase
    .from('customers')
    .select('id, name')
    .eq('owner_id', userId)
    .eq('status', 'active');
  const byName = new Map((existing ?? []).map((c) => [normalizeName(c.name), c.id]));

  const result: CommitResult = { customers: [], interactionIds: [], scheduleIds: [], taskIds: [] };
  // people配列のindex → 実際のcustomer_id（schedules/tasksの紐付け解決に使う）
  const personIds: (string | null)[] = [];

  for (const person of proposals.people) {
    const name = person.name?.trim();
    if (!name) {
      personIds.push(null);
      continue;
    }
    // 明示指定が無くても、正規化名が既存と一致するなら既存へ寄せる（重複登録の防止）。
    let customerId = person.customer_id ?? byName.get(normalizeName(name)) ?? null;
    const isNew = !customerId;

    if (customerId) {
      await Promise.all([
        supabase.rpc('merge_customer_custom_fields', {
          target_customer_id: customerId,
          new_fields: (person.custom_fields ?? {}) as never,
        }),
        supabase
          .from('customers')
          .update({ needs: joinList(person.needs), last_met_at: now, updated_at: now })
          .eq('id', customerId),
      ]);
    } else {
      const { data: created, error } = await supabase
        .from('customers')
        .insert({
          org_id: orgId,
          owner_id: userId,
          name,
          needs: joinList(person.needs),
          temperature: 'cold', // 新規は履歴が無いためcoldから開始し、直後に再計算する
          custom_fields: (person.custom_fields ?? {}) as never,
          last_met_at: now,
        })
        .select('id')
        .single();
      if (error || !created) throw new Error(`つながりの作成に失敗しました: ${error?.message ?? ''}`);
      customerId = created.id;
      byName.set(normalizeName(name), customerId);
    }

    personIds.push(customerId);
    result.customers.push({ id: customerId, name, isNew });

    const aiSummary: AiSummary = {
      points: person.points ?? [],
      needs: person.needs ?? [],
      next_actions: person.next_actions ?? [],
    };
    // 議事録は主たる相手（最初の1人）の履歴にだけ残す（全員に重複させない）。
    const summaryWithMinutes = !minutesAttached && minutes ? { ...aiSummary, minutes } : aiSummary;
    if (!minutesAttached && minutes) minutesAttached = true;
    const [, interaction] = await Promise.all([
      recomputeTemperature(supabase, customerId, now),
      supabase
        .from('interactions')
        .insert({
          org_id: orgId,
          customer_id: customerId,
          author_id: userId,
          source: 'ai_dialogue',
          type: 'text',
          raw_text: transcript,
          ai_summary: summaryWithMinutes as never,
          met_at: now,
        })
        .select('id')
        .single(),
    ]);
    if (interaction.data) result.interactionIds.push(interaction.data.id);
  }

  for (const s of proposals.schedules) {
    if (!s.title?.trim() || !s.start_at) continue;
    const { data, error } = await supabase
      .from('schedules')
      .insert({
        org_id: orgId,
        owner_id: userId,
        customer_id: s.person_index !== null ? (personIds[s.person_index] ?? null) : null,
        title: s.title,
        start_at: s.start_at,
        end_at: s.end_at,
        location: s.location ?? null,
        mode: s.mode ?? null,
        category: s.category ?? null,
      })
      .select('id')
      .single();
    if (!error && data) result.scheduleIds.push(data.id);
  }

  for (const t of proposals.tasks) {
    if (!t.title?.trim()) continue;
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        org_id: orgId,
        owner_id: userId,
        customer_id: t.person_index !== null ? (personIds[t.person_index] ?? null) : null,
        title: t.title,
        due_at: t.due_at,
        source: 'assistant',
      })
      .select('id')
      .single();
    if (!error && data) result.taskIds.push(data.id);
  }

  const notes = (proposals.self_notes ?? []).filter((n) => typeof n === 'string' && n.trim());
  const fields = cleanFields(proposals.self_fields);
  if (notes.length > 0 || fields) {
    // SelfOsaraiの保存と同じ経路（既存の他項目を壊さないアトミックなjsonbマージ）
    await supabase.rpc('merge_user_profile_fields', { new_notes: notes, new_fields: (fields ?? {}) as never });
  }

  return result;
}

function joinList(v?: string[]): string | null {
  if (!v || v.length === 0) return null;
  return v.join(' / ');
}

function cleanFields(fields?: Record<string, string>): Record<string, string> | null {
  if (!fields) return null;
  const cleaned = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
  );
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/** 温度感を直近接触日と直近60日の予定件数から再計算する（既存 osarai/turn と同一ロジック）。 */
async function recomputeTemperature(supabase: DB, customerId: string, lastMetAt: string): Promise<void> {
  const { data: current } = await supabase
    .from('customers')
    .select('temperature')
    .eq('id', customerId)
    .maybeSingle();
  const sixtyDaysAgo = new Date(Date.parse(lastMetAt) - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('schedules')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .gte('start_at', sixtyDaysAgo)
    .or('category.neq.私用,category.is.null');
  const temperature = computeAutoTemperature({ lastMetAt, recentMeetingCount: count ?? 0 });
  if (temperature === current?.temperature) return;
  await supabase.from('customers').update({ temperature }).eq('id', customerId);
}
