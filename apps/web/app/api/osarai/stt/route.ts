// おさらい音声入力の文字起こし（§8-1 音声入力）。
// モバイルで録った短い発話音声(base64)を受け取り、Gemini で文字起こしして返す。
// 返した transcript は、そのまま /api/osarai/turn の message として使う想定。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { geminiTranscribe } from '@/lib/gemini';

export const runtime = 'nodejs';
// 音声(base64)を含むため上限を引き上げ
export const maxDuration = 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: CORS_HEADERS });
  }

  const body = (await req.json()) as { audioBase64?: string; mimeType?: string };
  const audioBase64 = body.audioBase64 ?? '';
  const mimeType = body.mimeType ?? 'audio/webm';
  if (!audioBase64) {
    return NextResponse.json({ error: 'audioBase64 required' }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const text = await geminiTranscribe(audioBase64, mimeType);
    return NextResponse.json({ text }, { headers: CORS_HEADERS });
  } catch (e) {
    return NextResponse.json(
      { error: 'transcribe failed', detail: String(e) },
      { status: 502, headers: CORS_HEADERS },
    );
  }
}
