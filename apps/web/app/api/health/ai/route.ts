import { NextResponse } from 'next/server';
import { geminiPing } from '@/lib/gemini';

// AI(Gemini)疎通の確認。本番スモーク(scripts/prod-smoke.mjs)から1日1回だけ叩く。
// ★トークン必須にしている理由: 公開のまま Gemini を叩けるエンドポイントを置くと、
//   第三者に連打されて課金が発生しうるため。可用性チェック自体は /api/health（公開）で足りる。
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const expected = process.env.SMOKE_TOKEN ?? '';
  const given = req.headers.get('x-smoke-token') ?? '';
  // 未設定の本番で誰でも叩ける状態にしないため、env が無ければ常に拒否する。
  if (!expected || given !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const ping = await geminiPing();
  return NextResponse.json(ping, { status: ping.ok ? 200 : 503 });
}
