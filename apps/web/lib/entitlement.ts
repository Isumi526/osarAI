// 契約に基づく機能アクセス判定（サーバー側の砦・§11/§16）。
// クライアントのゲートは体験用。実際のアクセス制限はここ（API）で担保する。
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@osarai/shared/database.types';
import { isSubscriptionActive, planDef, type PlanDef } from '@osarai/shared';

export interface Entitlement {
  active: boolean;
  status: string | null;
  plan: string | null;
  def: PlanDef | null;
}

export async function getEntitlement(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Entitlement> {
  const { data } = await supabase
    .from('subscriptions')
    .select('status, plan')
    .eq('user_id', userId)
    .maybeSingle();
  const status = data?.status ?? null;
  const plan = data?.plan ?? null;
  return { active: isSubscriptionActive(status), status, plan, def: planDef(plan) };
}
