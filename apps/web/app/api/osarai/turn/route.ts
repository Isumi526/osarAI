// おさらい対話 1ターン処理（★コア・§8-1）。
// フロー: ユーザー発話 → Gemini が(抽出 + 次の質問 + done)を返す → 対話を保存。
// done になったら抽出を統合して interactions(source=ai_dialogue) を作成し、
// customers を更新（無ければ抽出した名前で新規作成）、osarai_sessions を done に。
import { NextResponse } from 'next/server';
import {
  buildOsaraiPrompt,
  OSARAI_SYSTEM_PROMPT,
  type OsaraiTurnResult,
  type OsaraiExtracted,
  type AiSummary,
} from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { geminiJson, GEMINI_MODEL_DIALOGUE, type GeminiSchema } from '@/lib/gemini';

export const runtime = 'nodejs';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// 埋めたい顧客カード項目（プロンプトに渡す説明）
const CARD_SCHEMA_DESC =
  '{points: 会話の要点(配列), needs: 相手の要望/困りごと(配列), ' +
  'temperature: 見込み温度(hot/warm/cold), next_actions: 次にやること(配列), ' +
  'custom_fields: その他特記事項(キー値)}';

// Gemini に強制する応答スキーマ（OsaraiTurnResult に対応）
const TURN_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    extracted: {
      type: 'object',
      properties: {
        points: { type: 'array', items: { type: 'string' } },
        needs: { type: 'array', items: { type: 'string' } },
        temperature: { type: 'string', enum: ['hot', 'warm', 'cold'], nullable: true },
        next_actions: { type: 'array', items: { type: 'string' } },
        custom_fields: { type: 'object', properties: {} },
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
    sessionId?: string;
    customerId?: string | null;
    message?: string;
  };
  const message = (body.message ?? '').trim();
  if (!message) return json({ error: 'message required' }, 400);

  // 自分の org_id（RLS の insert に必要）
  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) return json({ error: 'profile not found' }, 400);
  const orgId = profile.org_id;

  // --- セッション取得 or 新規作成 ---
  let sessionId = body.sessionId;
  let messages: ChatMessage[] = [];
  let customerId: string | null = body.customerId ?? null;

  if (sessionId) {
    const { data: sess, error } = await supabase
      .from('osarai_sessions')
      .select('id, messages, customer_id, status')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !sess) return json({ error: 'session not found' }, 404);
    if (sess.status === 'done') return json({ error: 'session already done' }, 409);
    messages = (sess.messages as ChatMessage[]) ?? [];
    customerId = sess.customer_id ?? customerId;
  } else {
    const { data: created, error } = await supabase
      .from('osarai_sessions')
      .insert({ org_id: orgId, user_id: user.id, customer_id: customerId, messages: [] })
      .select('id')
      .single();
    if (error || !created) return json({ error: 'session create failed' }, 500);
    sessionId = created.id;
  }

  // 既存顧客データ（あれば差分を聞かせる）
  let customerJson = 'なし';
  if (customerId) {
    const { data: c } = await supabase
      .from('customers')
      .select('name, needs, temperature, custom_fields, last_met_at')
      .eq('id', customerId)
      .maybeSingle();
    if (c) customerJson = JSON.stringify(c);
  }

  // ユーザー発話を履歴に追加
  messages.push({ role: 'user', content: message });

  // --- Gemini 1ターン ---
  const history = messages.map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
  const prompt = buildOsaraiPrompt({ schema: CARD_SCHEMA_DESC, customerJson, history });

  let result: OsaraiTurnResult;
  try {
    result = await geminiJson<OsaraiTurnResult>(prompt, TURN_SCHEMA, {
      model: GEMINI_MODEL_DIALOGUE,
      system: OSARAI_SYSTEM_PROMPT,
    });
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e) }, 502);
  }

  // AI の質問を履歴に追加（done のときは next_question=null）
  if (result.next_question) {
    messages.push({ role: 'assistant', content: result.next_question });
  }

  // --- 完了処理 ---
  let resultingInteractionId: string | null = null;
  if (result.done) {
    const persisted = await persistOnDone({
      supabase,
      orgId,
      authorId: user.id,
      customerId,
      extracted: result.extracted,
      messages,
    });
    if ('error' in persisted) return json(persisted, 500);
    customerId = persisted.customerId;
    resultingInteractionId = persisted.interactionId;
  }

  // セッション更新
  await supabase
    .from('osarai_sessions')
    .update({
      messages: messages as unknown as never,
      customer_id: customerId,
      status: result.done ? 'done' : 'in_progress',
      resulting_interaction_id: resultingInteractionId,
    })
    .eq('id', sessionId);

  return json(
    {
      sessionId,
      customerId,
      next_question: result.next_question,
      done: result.done,
      extracted: result.extracted,
      interactionId: resultingInteractionId,
    },
    200,
  );
}

interface PersistArgs {
  supabase: import('@supabase/supabase-js').SupabaseClient<
    import('@osarai/shared/database.types').Database
  >;
  orgId: string;
  authorId: string;
  customerId: string | null;
  extracted: OsaraiExtracted;
  messages: ChatMessage[];
}

async function persistOnDone(
  args: PersistArgs,
): Promise<{ customerId: string; interactionId: string } | { error: string }> {
  const { supabase, orgId, authorId, extracted } = args;
  const now = new Date().toISOString();

  // 顧客が未指定なら抽出名で新規カード作成（おさらいからカード自動生成・§8-1）
  let customerId = args.customerId;
  if (!customerId) {
    const inferredName = inferName(extracted) ?? '新しく会った人';
    const { data: c, error } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        owner_id: authorId,
        name: inferredName,
        needs: joinList(extracted.needs),
        temperature: extracted.temperature ?? null,
        custom_fields: (extracted.custom_fields ?? {}) as never,
        last_met_at: now,
      })
      .select('id')
      .single();
    if (error || !c) return { error: 'customer create failed' };
    customerId = c.id;
  } else {
    await supabase
      .from('customers')
      .update({
        needs: joinList(extracted.needs),
        temperature: extracted.temperature ?? null,
        last_met_at: now,
        updated_at: now,
      })
      .eq('id', customerId);
  }

  const aiSummary: AiSummary = {
    points: extracted.points ?? [],
    needs: extracted.needs ?? [],
    next_actions: extracted.next_actions ?? [],
  };
  const transcript = args.messages
    .map((m) => `${m.role === 'user' ? 'あなた' : 'AI'}: ${m.content}`)
    .join('\n');

  const { data: interaction, error } = await supabase
    .from('interactions')
    .insert({
      org_id: orgId,
      customer_id: customerId,
      author_id: authorId,
      source: 'ai_dialogue',
      type: 'text',
      raw_text: transcript,
      ai_summary: aiSummary as never,
      met_at: now,
    })
    .select('id')
    .single();
  if (error || !interaction) return { error: 'interaction create failed' };

  return { customerId, interactionId: interaction.id };
}

function joinList(v?: string[]): string | null {
  if (!v || v.length === 0) return null;
  return v.join(' / ');
}

// custom_fields に名前らしき項目があれば拾う（無ければ null）
function inferName(extracted: OsaraiExtracted): string | null {
  const cf = extracted.custom_fields ?? {};
  for (const key of ['name', '名前', '氏名', 'customer_name']) {
    const v = cf[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
