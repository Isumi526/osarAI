import { NextResponse } from 'next/server';

// Scaffold の疎通確認用。フェーズ1のみ。
export function GET() {
  return NextResponse.json({ ok: true, service: 'osarai-web' });
}
