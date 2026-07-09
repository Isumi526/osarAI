// 顧客登録AI解析（紹介文/自己紹介文面のテキスト、または自己紹介シート画像から
// 顧客カードの初期値を抽出）。抽出結果を返すのみで、実際の保存はクライアント側の
// 通常の顧客作成フロー（確認・修正込み）に委ねる（おさらい対話と同じ確認ステップの原則）。
import { NextResponse } from 'next/server';
import { geminiJson, geminiJsonFromImage, GEMINI_MODEL_LITE, type GeminiSchema } from '@/lib/gemini';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const maxDuration = 30;

// 画像は自己紹介シート程度の想定。録音(25MB)より小さく抑える。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ANALYZE_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', nullable: true },
    needs: { type: 'string', nullable: true },
    temperature: { type: 'string', enum: ['hot', 'warm', 'cold'], nullable: true },
  },
  required: ['name', 'needs', 'temperature'],
};

const INSTRUCTION =
  '次の自己紹介・紹介文から、顧客カードに登録する情報を抽出してください。' +
  '{name: 相手の名前, needs: 相手のニーズ・困りごと・関心事(1〜2文), ' +
  'temperature: 見込み度合いをhot/warm/coldのいずれかで(判断できなければnull)}。' +
  '情報が読み取れない項目はnullにしてください。出力は必ずJSONのみ。';

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);

  const body = (await req.json()) as {
    text?: string;
    imageBase64?: string;
    mimeType?: string;
  };

  const text = (body.text ?? '').trim();
  const hasImage = Boolean(body.imageBase64 && body.mimeType);
  if (!text && !hasImage) {
    return json({ error: 'text or image required' }, 400);
  }

  try {
    if (hasImage) {
      const bytes = Buffer.byteLength(body.imageBase64!, 'base64');
      if (bytes > MAX_IMAGE_BYTES) {
        return json(
          {
            error: 'image_too_large',
            message: `画像が大きすぎます（上限${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB）。`,
          },
          413,
        );
      }
      const extracted = await geminiJsonFromImage<Extracted>(
        body.imageBase64!,
        body.mimeType!,
        INSTRUCTION,
        ANALYZE_SCHEMA,
      );
      return json({ extracted }, 200);
    }

    const extracted = await geminiJson<Extracted>(`${INSTRUCTION}\n\n【対象テキスト】\n${text}`, ANALYZE_SCHEMA, {
      model: GEMINI_MODEL_LITE,
      temperature: 0,
    });
    return json({ extracted }, 200);
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e instanceof Error ? e.message : e) }, 502);
  }
}

interface Extracted {
  name: string | null;
  needs: string | null;
  temperature: 'hot' | 'warm' | 'cold' | null;
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
