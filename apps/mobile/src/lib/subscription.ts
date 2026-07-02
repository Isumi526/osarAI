// 契約状態の取得（クライアントの体験用ゲート・§11/§16）。
// 実アクセス制限はサーバー(API)側で担保。ここは導線の出し分けのみ。
import { supabase } from './supabase.js';
import { isSubscriptionActive, planDef, type PlanDef } from '@osarai/shared';

export interface Entitlement {
  active: boolean;
  status: string | null;
  plan: string | null;
  def: PlanDef | null;
}

export async function getEntitlement(): Promise<Entitlement> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { active: false, status: null, plan: null, def: null };
  const { data } = await supabase
    .from('subscriptions')
    .select('status, plan')
    .eq('user_id', user.id)
    .maybeSingle();
  const status = data?.status ?? null;
  const plan = data?.plan ?? null;
  return { active: isSubscriptionActive(status), status, plan, def: planDef(plan) };
}
