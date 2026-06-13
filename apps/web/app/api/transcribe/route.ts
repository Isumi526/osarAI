import { NextResponse } from 'next/server';

// 文字起こし（録音サブ経路・§8-2）。Storage音声→Gemini→transcript→要約。— 実装はフェーズ8。
export function POST() {
  return NextResponse.json({ todo: 'phase8: transcribe' }, { status: 501 });
}
