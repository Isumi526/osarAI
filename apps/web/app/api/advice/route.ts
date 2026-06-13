import { NextResponse } from 'next/server';

// AI戦略相談（§8-3）。scope=all/customer でコンテキスト化→Gemini。— 実装はフェーズ7。
export function POST() {
  return NextResponse.json({ todo: 'phase7: advice' }, { status: 501 });
}
