// 「リーダー」課金プラン契約者の商品リスト管理（【要設計判断】代理店/リーダー再設計・回答A）。
// GET: 自分の商品(リーダー本人) または 自分を招待したリーダーの商品(招待メンバー)のみ
// (RLS: agency_products_select・org全体スコープではない)。
// POST: 有効なLeaderプラン契約者のみ作成可(RLS: agency_products_cud)。RLSが最終防衛だが、
// 無駄なinsert試行を避けるためここでも確認する。
import { NextResponse } from 'next/server';
import { authedFromRequest } from '@/lib/api-auth';

export async function GET(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { data, error } = await ctx.supabase
    .from('agency_products')
    .select('id, name, price, appeal, target')
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ products: data ?? [] });
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { supabase, user } = ctx;

  const { data: profile } = await supabase.from('profiles').select('org_id').eq('id', user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 400 });
  const { data: sub } = await supabase.from('subscriptions').select('plan, status').eq('user_id', user.id).maybeSingle();
  const isActiveLeader = sub?.plan === 'leader' && (sub.status === 'trialing' || sub.status === 'active');
  if (!isActiveLeader) return NextResponse.json({ error: 'active leader plan only' }, { status: 403 });

  const body = (await req.json()) as { name?: string; price?: string; appeal?: string; target?: string };
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const { data, error } = await supabase
    .from('agency_products')
    .insert({
      org_id: profile.org_id,
      created_by: user.id,
      name,
      price: body.price?.trim() || null,
      appeal: body.appeal?.trim() || null,
      target: body.target?.trim() || null,
    })
    .select('id, name, price, appeal, target')
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'create failed' }, { status: 500 });
  return NextResponse.json({ product: data });
}
