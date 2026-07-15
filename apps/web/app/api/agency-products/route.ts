// 代理店(leader)の商品リスト管理（議事録『review』回答A）。
// GET: 同組織メンバー全員が閲覧可(RLS: agency_products_select)。
// POST: leaderのみ作成可(RLS: agency_products_cud)。RLSが最終防衛だが、無駄なinsert試行を
// 避けるためrole確認もここで行う。
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

  const { data: profile } = await supabase.from('profiles').select('org_id, role').eq('id', user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 400 });
  if (profile.role !== 'leader') return NextResponse.json({ error: 'leader only' }, { status: 403 });

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
