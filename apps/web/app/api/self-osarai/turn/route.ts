// 「自分をおさらいする」対話 1ターン処理（顧客向けおさらいとは別）。
// 顧客カード/interactionsは作らず、抽出結果(notes)はクライアントが完了時に
// profiles.user_profile.notesへ直接蓄積する。ステートレス(履歴は毎回クライアントから送る)
// なので専用のセッションテーブルは持たない(低優先度機能のため軽量実装)。
import { NextResponse } from 'next/server';
import { SELF_OSARAI_SYSTEM_PROMPT, type SelfOsaraiTurnResult } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { geminiJson, GEMINI_MODEL_DIALOGUE, type GeminiSchema } from '@/lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const TURN_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    extracted: {
      type: 'object',
      properties: {
        notes: { type: 'array', items: { type: 'string' } },
        fields: {
          type: 'object',
          properties: {
            job: { type: 'string', nullable: true },
            products: { type: 'string', nullable: true },
          },
        },
      },
    },
    next_question: { type: 'string', nullable: true },
    done: { type: 'boolean' },
  },
  required: ['extracted', 'next_question', 'done'],
};

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json()) as {
    message?: string;
    history?: ChatMessage[];
    forceEnd?: boolean;
  };
  const forceEnd = body.forceEnd === true;
  const message = (body.message ?? '').trim();
  if (!message && !forceEnd) return json({ error: 'message required' }, 400);

  // 契約ゲート（既存おさらい/相談と同じ・§16）
  const ent = await getEntitlement(supabase, user.id);
  if (!ent.active) {
    return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  }

  const messages: ChatMessage[] = [...(body.history ?? [])];
  if (message) messages.push({ role: 'user', content: message });
  if (forceEnd && messages.length === 0) {
    return json({ error: 'nothing to summarize yet' }, 400);
  }

  // これまでに蓄積された自己おさらいの気づき(notes)を取得し、プロンプトに含める
  // （AC④: 何度でも実行でき過去の蓄積の上に積み増す。同じことを聞き直さず差分を深掘りするため）。
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, user_profile')
    .eq('id', user.id)
    .maybeSingle();
  const userProfile = (profile?.user_profile as { notes?: string[]; job?: string; products?: string } | null) ?? {};
  const existingNotes = (userProfile.notes ?? []).filter((n) => typeof n === 'string' && n.trim());
  const notesBlock =
    existingNotes.length > 0
      ? `\n\nこれまでに蓄積された、この人についての気づき:\n${existingNotes.map((n) => `- ${n}`).join('\n')}`
      : '\n\nこれまでに蓄積された気づき: なし（初回）';

  // 議事録『review(2回目)』要望: 初回はまず名前を確認し、仕事・扱っている商品が
  // 未登録なら優先的にヒアリングする(Settingsの構造化フィールドの空欄状況を伝える)。
  const nameBlock = profile?.display_name
    ? `\n\n登録名: ${profile.display_name}(既に分かっている。改めて名前は聞かない)`
    : '\n\n登録名: 未登録(対話の最初にお名前を確認すること)';
  const missingFields: string[] = [];
  if (!userProfile.job) missingFields.push('仕事');
  if (!userProfile.products) missingFields.push('扱っている商品');
  const missingFieldsBlock =
    missingFields.length > 0
      ? `\n未登録の項目(優先的にヒアリング): ${missingFields.join('・')}`
      : '\n仕事・扱っている商品は登録済み。自由な深掘りでよい。';

  const history = messages.map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
  const prompt = `${SELF_OSARAI_SYSTEM_PROMPT}${notesBlock}${nameBlock}${missingFieldsBlock}\n\n対話履歴:\n${history}`;

  let result: SelfOsaraiTurnResult;
  try {
    result = await geminiJson<SelfOsaraiTurnResult>(prompt, TURN_SCHEMA, {
      model: GEMINI_MODEL_DIALOGUE,
    });
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e) }, 502);
  }
  if (forceEnd) {
    result = { ...result, done: true, next_question: null };
  }
  if (result.next_question) {
    messages.push({ role: 'assistant', content: result.next_question });
  }

  return json({ next_question: result.next_question, done: result.done, extracted: result.extracted, history: messages }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
