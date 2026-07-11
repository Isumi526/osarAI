// 顧客・対応履歴・プロフィールのデータアクセス（RLSがテナント/owner分離を担保）。
import { supabase } from './supabase.js';
import type { Database } from '@osarai/shared/database.types';
import type { CustomerStatus, Temperature } from '@osarai/shared';

export type Customer = Database['public']['Tables']['customers']['Row'];
export type Interaction = Database['public']['Tables']['interactions']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];

export async function getMyProfile(): Promise<Profile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
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

// 「自分をおさらいする」対話の抽出結果(notes + job/products等の構造化フィールド)を
// アトミックに保存する(migration 0013)。job/productsがuser_profileに反映されず、
// 次回以降も未登録扱いのまま同じ質問を聞き直してしまうバグの修正。
// notesの追記のみで構造化フィールドが無い場合は既存のappendUserProfileNotesと等価。
export async function saveSelfOsaraiExtraction(
  newNotes: string[],
  fields: { job?: string; products?: string; age?: string; gender?: string; background?: string; goal?: string } = {},
): Promise<void> {
  const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => !!v && v.trim()));
  if (newNotes.length === 0 && Object.keys(cleanFields).length === 0) return;
  const { error } = await supabase.rpc('merge_user_profile_fields', {
    new_notes: newNotes,
    new_fields: cleanFields,
  });
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
export interface CustomerInput {
  name: string;
  temperature: Temperature | null;
  needs: string | null;
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
      temperature: input.temperature,
      needs: input.needs,
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
      temperature: input.temperature,
      needs: input.needs,
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
  points: string[];
  needs: string[];
  next_actions: string[];
  temperature: Temperature | null;
  name?: string;
}

/**
 * おさらい対話完了時にAIが生成したサマリを、ユーザーの確認・修正後に保存する（F-02 AC）。
 * turn API側で自動保存済みの interaction/customer を、編集内容で上書きする。
 * RLS(interactions_cud: author_id=auth.uid() / customers_cud: owner_id=auth.uid())が
 * 本人分のみ更新可能であることを担保する。
 */
export async function updateInteractionSummary(
  interactionId: string,
  customerId: string,
  edit: SummaryEdit,
): Promise<void> {
  const { error: ixError } = await supabase
    .from('interactions')
    .update({
      ai_summary: { points: edit.points, needs: edit.needs, next_actions: edit.next_actions } as never,
    })
    .eq('id', interactionId);
  if (ixError) throw ixError;

  const { error: custError } = await supabase
    .from('customers')
    .update({
      temperature: edit.temperature,
      needs: edit.needs.length ? edit.needs.join(' / ') : null,
      updated_at: new Date().toISOString(),
      ...(edit.name && edit.name.trim() ? { name: edit.name.trim() } : {}),
    })
    .eq('id', customerId);
  if (custError) throw custError;
}
