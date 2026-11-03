// 顧客・対応履歴・プロフィールのデータアクセス（RLSがテナント/owner分離を担保）。
import { supabase } from './supabase.js';
import type { Database } from '@osarai/shared/database.types';
import type { CustomerStatus, Temperature } from '@osarai/shared';
import { computeAutoTemperature } from '@osarai/shared';

export type Customer = Database['public']['Tables']['customers']['Row'];
export type Interaction = Database['public']['Tables']['interactions']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type AgencyProduct = Database['public']['Tables']['agency_products']['Row'];

// 代理店(leader)が作成した商品リスト（議事録『review』回答A）。同組織メンバーは
// RLS(agency_products_select)で閲覧のみ可能。管理(作成/編集/削除)はWeb(/dashboard/products・
// leaderのみ)で行う。
export async function listAgencyProducts(): Promise<AgencyProduct[]> {
  const { data, error } = await supabase.from('agency_products').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as AgencyProduct[]) ?? [];
}

export async function getMyProfile(): Promise<Profile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

/**
 * 自分の表示名（本名）を更新する。会議の文字起こしで「自分」と「相手」を見分けるのに使うので、
 * 本名（漢字）を入れてもらう（2026-09-27・マイページに入力欄が無かったため追加）。
 */
export async function updateMyDisplayName(displayName: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const { error } = await supabase.from('profiles').update({ display_name: displayName.trim() || null }).eq('id', user.id);
  if (error) throw error;
}

// AI戦略相談のコンテキストに使う自由記述プロフィール（年齢/性別/経歴/仕事/扱い商品/目標）。
// 目標(goals)は構造化配列を持つため値はstring以外(配列)も許容する。
export async function updateMyUserProfile(userProfile: Record<string, unknown>): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const { error } = await supabase
    .from('profiles')
    .update({ user_profile: userProfile as never })
    .eq('id', user.id);
  if (error) throw error;
}

// 「自分をおさらいする」対話の抽出結果(notes)を既存user_profileに追記蓄積する
// (上書きではなく既存のnotes配列の末尾に追加)。他の項目(age/gender等)は変更しない。
// アトミックなRPC(append_user_profile_notes・migration 0011)を使う。クライアント側の
// fetch→マージ→updateは読み取りと書き込みの間に競合状態があったため避けた。
export async function appendUserProfileNotes(newNotes: string[]): Promise<void> {
  if (newNotes.length === 0) return;
  const { error } = await supabase.rpc('append_user_profile_notes', { new_notes: newNotes });
  if (error) throw error;
}

// 「自分をおさらいする」対話の抽出結果を保存する。
// 気づき(notes)は自由記述の「自分のメモ」(profiles.profile_text)へ1行ずつアトミックに追記し
// (append_profile_text・migration 0035。旧 user_profile.notes には書かない)、
// job/products等の構造化フィールドは従来どおり user_profile にアトミックにマージする(migration 0013)。
export async function saveSelfOsaraiExtraction(
  newNotes: string[],
  fields: { job?: string; products?: string; age?: string; gender?: string; background?: string; goal?: string } = {},
): Promise<void> {
  const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => !!v && v.trim()));
  const lines = newNotes.map((n) => n.trim()).filter(Boolean);
  if (lines.length > 0) {
    const { error } = await supabase.rpc('append_profile_text', { addition: lines.join('\n') });
    if (error) throw error;
  }
  if (Object.keys(cleanFields).length > 0) {
    const { error } = await supabase.rpc('merge_user_profile_fields', { new_notes: [], new_fields: cleanFields });
    if (error) throw error;
  }
}

// 自分のメモ(profiles.profile_text・migration 0035)を書き換える(設定画面での手直し)。
// 空にした場合は空文字で保存する(null に戻すと旧 user_profile.notes が読み取り用に再び出てくるため)。
export async function updateMyProfileText(text: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('not authenticated');
  const { error } = await supabase.from('profiles').update({ profile_text: text.trim() }).eq('id', user.id);
  if (error) throw error;
}

export async function listCustomers(opts: {
  status?: CustomerStatus;
  temperature?: Temperature;
}): Promise<Customer[]> {
  let q = supabase.from('customers').select('*').order('updated_at', { ascending: false });
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.temperature) q = q.eq('temperature', opts.temperature);
  const { data, error } = await q;
  if (error) throw error;
  return (data as Customer[]) ?? [];
}

export async function getCustomer(id: string): Promise<Customer | null> {
  const { data, error } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Customer | null) ?? null;
}

export async function listInteractions(customerId: string): Promise<Interaction[]> {
  const { data, error } = await supabase
    .from('interactions')
    .select('*')
    .eq('customer_id', customerId)
    .order('met_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Interaction[]) ?? [];
}

// ステータス(対応中/アーカイブ)はユーザーには意識させない概念。新規作成は常にactive、
// 「削除」操作は物理削除ではなくarchivedへの論理削除として扱う(議事録『review』人力回答A)。
// つながりの区分。将来の追加を考慮しtext自由記述だが、UIは固定リストから選ぶ。
export const RELATION_TYPES = ['つながり', '顧客', 'パートナー'] as const;
export const DEFAULT_RELATION_TYPE = 'つながり';

export interface CustomerInput {
  name: string;
  /** この人のメモ（customers.profile_notes・自由記述・migration 0035）。旧 needs には書かない */
  profileNotes: string | null;
  relationType: string | null;
}

// 温度感(hot/warm/cold)は手動設定UIを廃止し、直近接触日+直近アポ件数から自動算出する
// （議事録『review』回答A）。customers.last_met_at と直近60日の予定件数(私用除く)を見て
// computeAutoTemperature()で再計算し、変化があれば保存する。おさらい完了時・予定保存時に呼ぶ。
export async function recomputeCustomerTemperature(customerId: string): Promise<void> {
  const { data: customer, error: custError } = await supabase
    .from('customers')
    .select('last_met_at, temperature')
    .eq('id', customerId)
    .maybeSingle();
  if (custError) throw custError;
  if (!customer) return;

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error: schedError } = await supabase
    .from('schedules')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .gte('start_at', sixtyDaysAgo)
    .or('category.neq.私用,category.is.null');
  if (schedError) throw schedError;

  const next = computeAutoTemperature({ lastMetAt: customer.last_met_at, recentMeetingCount: count ?? 0 });
  if (next === customer.temperature) return;
  const { error: updateError } = await supabase.from('customers').update({ temperature: next }).eq('id', customerId);
  if (updateError) throw updateError;
}

export async function createCustomer(
  input: CustomerInput,
  profile: Pick<Profile, 'id' | 'org_id'>,
): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      org_id: profile.org_id, // RLS: org_id = current_org_id()
      owner_id: profile.id, //    owner_id = auth.uid()
      name: input.name,
      temperature: 'cold' satisfies Temperature, // 新規は履歴が無いためcoldから開始。以後は自動算出。
      profile_notes: input.profileNotes,
      relation_type: input.relationType,
      status: 'active' satisfies CustomerStatus,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Customer;
}

export async function updateCustomer(id: string, input: CustomerInput): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({
      name: input.name,
      profile_notes: input.profileNotes,
      relation_type: input.relationType,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

// 「削除」は論理削除(status=archived)。一覧・選択肢からは外れるがデータ(履歴含む)は保持される。
export async function archiveCustomer(id: string): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({ status: 'archived' satisfies CustomerStatus, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export interface SummaryEdit {
  /** その回の要約（自由記述・interactions.summary・migration 0035） */
  memo: string;
  name?: string;
}

/**
 * おさらい対話完了時にAIが生成したサマリを、ユーザーの確認・修正後に保存する（F-02 AC）。
 * turn API側で自動保存済みの interaction/customer を、編集内容で上書きする。
 * RLS(interactions_cud: author_id=auth.uid() / customers_cud: owner_id=auth.uid())が
 * 本人分のみ更新可能であることを担保する。
 * 温度感は手動入力を廃止したためここでは触らず、保存後にrecomputeCustomerTemperature()で
 * 自動算出する（last_met_at はturn API側で既に更新済み）。
 */
export async function updateInteractionSummary(
  interactionId: string,
  customerId: string,
  edit: SummaryEdit,
): Promise<void> {
  // 要約は自由記述1本で interactions.summary に保存する（旧 ai_summary.points 等・customers.needs には書かない）
  const { error: ixError } = await supabase
    .from('interactions')
    .update({ summary: edit.memo.trim() || null })
    .eq('id', interactionId);
  if (ixError) throw ixError;

  const { error: custError } = await supabase
    .from('customers')
    .update({
      updated_at: new Date().toISOString(),
      ...(edit.name && edit.name.trim() ? { name: edit.name.trim() } : {}),
    })
    .eq('id', customerId);
  if (custError) throw custError;

  await recomputeCustomerTemperature(customerId);
}

// 表記揺れで二重登録されたつながりを1つにまとめる（0027 merge_customers RPC）。
// interactions / schedules / tasks / osarai_sessions / ai_chats の customer_id を
// まとめてサーバー側で付け替えるため、履歴が欠けることはない。
export async function mergeCustomers(sourceId: string, targetId: string): Promise<void> {
  const { error } = await supabase.rpc('merge_customers', { source_id: sourceId, target_id: targetId });
  if (error) throw error;
}

/** 表記揺れを吸収した比較キー（全角半角・敬称・空白を無視）。重複候補の検出に使う。 */
export function normalizeCustomerName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '')
    .toLowerCase();
}

/** 同一人物とみられるつながりの組を返す（正規化名が一致するもの）。 */
export function findDuplicateGroups(customers: Customer[]): Customer[][] {
  const byKey = new Map<string, Customer[]>();
  for (const c of customers) {
    const key = normalizeCustomerName(c.name);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}
