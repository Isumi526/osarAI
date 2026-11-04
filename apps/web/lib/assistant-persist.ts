// 統合AIチャット（2026-08-06 UI/UX刷新）の永続化。
// 誤登録防止のため、AIに保存させず「ユーザーが確認カードで編集した最終版」をここで
// 決定的に書き込む（/api/assistant/commit から呼ぶ）。
// 既存 osarai/turn の persistOnDone と同じ規律（wants_to_meet はマージRPC・温度感再計算・
// interactions(source='ai_dialogue')作成）を踏襲し、Homeの個人集計との互換を保つ。
// 2026-11-03（0035）から、人物ごとのメモは自由記述1本（memo）で受け取り、その回の要約は
// interactions.summary に書く。旧項目（needs / custom_fields の商品・年齢等 / ai_summary の
// points・needs・next_actions）には書かない。
// 2026-11-05（0036）から、この人について新しく分かったこと（card_note）は customers.profile_notes に
// 追記する。既存メモと同じ行は足さず、カードと同じ行はその回の要約から除く（splitCardNote）。
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@osarai/shared/database.types';
import {
  computeAutoTemperature,
  customerMemo,
  normalizeName,
  personMemo,
  personWantsToMeet,
  splitCardNote,
  type AiSummary,
  type SimilarNameCandidate,
} from '@osarai/shared';

type DB = SupabaseClient<Database>;

export interface PersonProposal {
  customer_id: string | null;
  name: string;
  /** その人について今回わかったこと・話した内容・約束（自由記述1本） */
  memo?: string;
  /** カードのメモに足す、この人について新しく分かったこと（profile_notes に追記・0036） */
  card_note?: string;
  /** 相手が「どんな人とつながりたいか」（Phase2 マッチングの入力・custom_fields.wants_to_meet に追記） */
  wants_to_meet?: string[];
  /** @deprecated 旧形式（0035 以前のクライアント・保存済みの会議候補）。personMemo で memo に読み替える */
  points?: string[];
  /** @deprecated 旧形式 */
  needs?: string[];
  /** @deprecated 旧形式 */
  next_actions?: string[];
  /** @deprecated 旧形式（wants_to_meet だけは personWantsToMeet で拾う） */
  custom_fields?: Record<string, unknown>;
  /**
   * 同一人物かもしれない既存つながりの候補（新規登録になる場合だけ付く・確認カードで確認を出す）。
   * サーバーは断定せず候補を出すだけで、寄せるかどうかはユーザーが決める。
   */
  similar?: SimilarNameCandidate[];
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
  /** 誰が引き受けたか（省略時 self）。other は「相手待ち」として別枠に並ぶ */
  assignee?: 'self' | 'other';
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
// 名前の正規化規則は @osarai/shared に集約した（表記揺れ検知と同じ規則を使うため）。
// 既存の import 元（proposal-extraction 等）を壊さないよう、ここから再exportする。
export { normalizeName };

export async function commitProposals(args: {
  supabase: DB;
  orgId: string;
  userId: string;
  proposals: Proposals;
  transcript: string;
  /** 会議の議事録（T3）。あれば主たる相手の履歴(interaction)に残してタイムラインで読めるようにする。 */
  minutes?: string | null;
  /**
   * interactions.source（既定 'ai_dialogue'）。会議録音は録音経路に応じて 'zoom_rec' / 'in_person_rec' を
   * 渡し、タイムラインで対話おさらいと区別できるようにする（T7）。
   */
  source?: 'ai_dialogue' | 'zoom_rec' | 'in_person_rec' | 'manual';
  /** 実際に会った日時（ISO）。会議録音は録音開始時刻を渡す。省略時は保存時刻。 */
  metAt?: string;
  /** 議事録を全員の履歴に付ける（会議録音の自動保存・各相手のカードから同じ会議を読み返せる） */
  minutesForAll?: boolean;
}): Promise<CommitResult> {
  const { supabase, orgId, userId, proposals, transcript, minutes } = args;
  const source = args.source ?? 'ai_dialogue';
  const now = new Date().toISOString();
  const metAt = args.metAt ?? now;
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

    const wants = personWantsToMeet(person);
    let summary = personMemo(person);

    if (customerId) {
      // 既存つながりの wants_to_meet（配列）は上書きせず追記する。1回の会議で相手の希望が
      // 全部再抽出される保証はなく、前回までの蓄積を消さない（T7）。
      const { data: cur } = await supabase
        .from('customers')
        .select('profile_notes, needs, custom_fields, last_met_at')
        .eq('id', customerId)
        .maybeSingle();
      // カードのメモには新しく分かったことだけを足す（書き直しは本人の編集に任せ、AI は追記のみ）
      const split = splitCardNote({ existing: cur ? customerMemo(cur) : '', cardNote: person.card_note, memo: summary });
      summary = split.summary;
      const mergedFields = wants.length
        ? mergeArrayFields((cur?.custom_fields as Record<string, unknown> | null) ?? {}, { wants_to_meet: wants })
        : null;
      await Promise.all([
        mergedFields
          ? supabase.rpc('merge_customer_custom_fields', {
              target_customer_id: customerId,
              new_fields: mergedFields as never,
            })
          : Promise.resolve(),
        split.additions
          ? supabase.rpc('append_customer_profile_notes', { target_customer_id: customerId, addition: split.additions })
          : Promise.resolve(),
        supabase
          .from('customers')
          // 承認が翌日以降にずれても、会議より新しい接触日を過去に戻さない
          .update({
            last_met_at: greaterIso(cur?.last_met_at ?? metAt, metAt),
            updated_at: now,
          })
          .eq('id', customerId),
      ]);
    } else {
      const split = splitCardNote({ existing: '', cardNote: person.card_note, memo: summary });
      summary = split.summary;
      const { data: created, error } = await supabase
        .from('customers')
        .insert({
          org_id: orgId,
          owner_id: userId,
          name,
          profile_notes: split.additions || null,
          temperature: 'cold', // 新規は履歴が無いためcoldから開始し、直後に再計算する
          custom_fields: (wants.length ? { wants_to_meet: wants } : {}) as never,
          last_met_at: metAt,
        })
        .select('id')
        .single();
      if (error || !created) throw new Error(`つながりの作成に失敗しました: ${error?.message ?? ''}`);
      customerId = created.id;
      byName.set(normalizeName(name), customerId);
    }

    personIds.push(customerId);
    result.customers.push({ id: customerId, name, isNew });

    // その回の要約は interactions.summary（自由記述）へ。ai_summary には議事録だけを残す（0035）。
    // 議事録は主たる相手（最初の1人）の履歴にだけ残す（全員に重複させない）。
    const attachMinutes = !!minutes && (args.minutesForAll || !minutesAttached);
    if (!minutesAttached && minutes) minutesAttached = true;
    const aiSummary: AiSummary | null = attachMinutes ? { minutes: minutes! } : null;
    const [, interaction] = await Promise.all([
      recomputeTemperature(supabase, customerId, metAt),
      supabase
        .from('interactions')
        .insert({
          org_id: orgId,
          customer_id: customerId,
          author_id: userId,
          source,
          type: 'text',
          raw_text: transcript,
          summary: summary || null,
          ai_summary: aiSummary as never,
          met_at: metAt,
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
        assignee: t.assignee === 'other' ? 'other' : 'self',
        source: 'assistant',
      })
      .select('id')
      .single();
    if (!error && data) result.taskIds.push(data.id);
  }

  const notes = (proposals.self_notes ?? []).filter((n) => typeof n === 'string' && n.trim());
  const fields = cleanFields(proposals.self_fields);
  // 自分についての気づきは自由記述の「自分のメモ」（profiles.profile_text・0035）へアトミックに追記する。
  // 仕事・年齢などの構造化項目（self_fields）は従来どおり user_profile へマージ（notes には書かない）。
  if (notes.length > 0) {
    await supabase.rpc('append_profile_text', { addition: notes.map((n) => n.trim()).join('\n') });
  }
  if (fields) {
    await supabase.rpc('merge_user_profile_fields', { new_notes: [], new_fields: fields as never });
  }

  return result;
}

/** 既存の needs(' / ' 連結) に新しいニーズを重複除去して追記する。新規が無ければ既存のまま。
 * 0035 以降は commitProposals からは使わない（needs に書かない）。旧データの扱い・テスト用に残す。 */
export function mergeNeeds(current: string | null, incoming?: string[]): string | null {
  const cur = (current ?? '').split(' / ').map((s) => s.trim()).filter(Boolean);
  const seen = new Set(cur.map(normalizeName));
  for (const n of incoming ?? []) {
    const t = n.trim();
    if (!t) continue;
    const key = normalizeName(t);
    if (seen.has(key)) continue;
    seen.add(key);
    cur.push(t);
  }
  return cur.length ? cur.join(' / ') : null;
}

/** custom_fields のうち配列項目（products / wants_to_meet 等）は既存と和集合にする。それ以外は新しい値で上書き。 */
export function mergeArrayFields(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const prev = current[k];
    if (Array.isArray(v) && Array.isArray(prev)) {
      const seen = new Set(prev.map((x) => String(x).trim()));
      out[k] = [...prev, ...v.filter((x) => !seen.has(String(x).trim()))];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function greaterIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
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
