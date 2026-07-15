// 代理店(leader)の紹介コード管理（議事録『review』回答A）。
// 【重要】ここではStripe側のPromotion Code発行は行わない（コード文字列の記録・使用状況
// 追跡のみ。実際のStripe発行は運営者がCLIで行う運用を維持。詳細はmigrationのコメント参照）。
import { NextResponse } from 'next/server';
import { authedFromRequest } from '@/lib/api-auth';

export async function GET(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { supabase, user } = ctx;

  const { data: profile } = await supabase.from('profiles').select('org_id').eq('id', user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 400 });

  const [{ data: codes, error }, { data: members }] = await Promise.all([
    supabase.from('referral_codes').select('id, code, label, created_at').order('created_at', { ascending: true }),
    supabase.from('profiles').select('channel_code').eq('org_id', profile.org_id),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // コード別の登録者数(同組織profiles.channel_codeを集計)。
  const countByCode = new Map<string, number>();
  for (const m of members ?? []) {
    const c = m.channel_code;
    if (c) countByCode.set(c, (countByCode.get(c) ?? 0) + 1);
  }
  const withCounts = (codes ?? []).map((c) => ({ ...c, signupCount: countByCode.get(c.code) ?? 0 }));
  return NextResponse.json({ codes: withCounts });
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { supabase, user } = ctx;

  const { data: profile } = await supabase.from('profiles').select('org_id, role').eq('id', user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: 'profile not found' }, { status: 400 });
  if (profile.role !== 'leader') return NextResponse.json({ error: 'leader only' }, { status: 403 });

  const body = (await req.json()) as { code?: string; label?: string };
  const code = (body.code ?? '').trim();
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 });

  const { data, error } = await supabase
    .from('referral_codes')
    .insert({ org_id: profile.org_id, created_by: user.id, code, label: body.label?.trim() || null })
    .select('id, code, label, created_at')
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'create failed' }, { status: 500 });
  return NextResponse.json({ referralCode: { ...data, signupCount: 0 } });
}
