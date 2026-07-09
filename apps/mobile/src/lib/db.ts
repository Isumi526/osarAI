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

// AI戦略相談のコンテキストに使う自由記述プロフィール（年齢/性別/経歴/仕事/扱い商品/目標）
export async function updateMyUserProfile(userProfile: Record<string, string>): Promise<void> {
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

export interface CustomerInput {
  name: string;
  temperature: Temperature | null;
  needs: string | null;
  status: CustomerStatus;
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
      status: input.status,
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
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw error;
}

export interface SummaryEdit {
  points: string[];
  needs: string[];
  next_actions: string[];
  temperature: Temperature | null;
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
    })
    .eq('id', customerId);
  if (custError) throw custError;
}
