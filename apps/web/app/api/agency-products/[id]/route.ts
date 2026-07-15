// 代理店商品リストの個別削除（議事録『review』回答A）。RLS(agency_products_cud)がleaderのみに限定する。
import { NextResponse } from 'next/server';
import { authedFromRequest } from '@/lib/api-auth';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const { error } = await ctx.supabase.from('agency_products').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
