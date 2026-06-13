import { NextResponse } from 'next/server';

// おさらい対話の1ターン処理（§8-1）。サーバー側でGeminiを叩く。— 実装はフェーズ6。
export function POST() {
  return NextResponse.json({ todo: 'phase6: osarai turn' }, { status: 501 });
}
