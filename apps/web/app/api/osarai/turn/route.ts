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
import { getEntitlement } from '@/lib/entitlement';
import { geminiJson, GEMINI_MODEL_DIALOGUE, type GeminiSchema } from '@/lib/gemini';

export const runtime = 'nodejs';
// lib/gemini.ts のリトライ+モデルフォールバックが最悪ケースでGemini呼び出しを複数回行うため余裕を持たせる
export const maxDuration = 60;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// 埋めたい顧客カード項目（プロンプトに渡す説明）
const CARD_SCHEMA_DESC =
  '{points: 会話の要点(配列), needs: 相手の要望/困りごと(配列), ' +
  'temperature: 見込み温度(hot/warm/cold), next_actions: 次にやること(配列), ' +
  'custom_fields: その他特記事項(キー値), name: 相手の名前(判明していれば)}';

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
        name: { type: 'string', nullable: true },
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
    forceEnd?: boolean;
  };
  const forceEnd = body.forceEnd === true;
  const message = (body.message ?? '').trim();
  if (!message && !forceEnd) return json({ error: 'message required' }, 400);

  // 契約ゲート（§16 未契約/解約は機能制限）
  const ent = await getEntitlement(supabase, user.id);
  if (!ent.active) {
    return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  }

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
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !sess) return json({ error: 'session not found' }, 404);
    if (sess.status === 'done') return json({ error: 'session already done' }, 409);
    messages = (sess.messages as ChatMessage[]) ?? [];
    customerId = sess.customer_id ?? customerId;
  } else if (forceEnd) {
    return json({ error: 'no session to end' }, 400);
  } else {
    const { data: created, error } = await supabase
      .from('osarai_sessions')
      .insert({ org_id: orgId, user_id: user.id, customer_id: customerId, messages: [] })
      .select('id')
      .single();
    if (error || !created) return json({ error: 'session create failed' }, 500);
    sessionId = created.id;
  }
  if (forceEnd && messages.length === 0) {
    return json({ error: 'nothing to summarize yet' }, 400);
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

  // ユーザー発話を履歴に追加（forceEndで空発話の場合は追加しない）
  if (message) messages.push({ role: 'user', content: message });

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
  // 明示的な終了操作は、Geminiの done 判定にかかわらずここまでの抽出内容で必ず完了させる
  if (forceEnd) {
    result = { ...result, done: true, next_question: null };
  }

  // AI の質問を履歴に追加（done のときは next_question=null）
  if (result.next_question) {
    messages.push({ role: 'assistant', content: result.next_question });
  }

  // --- 完了処理 ---
  let resultingInteractionId: string | null = null;
  let customerName: string | null = null;
  let isNewCustomer = false;
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
    customerName = persisted.customerName;
    isNewCustomer = persisted.isNewCustomer;
  }

  // セッション更新（interaction/customerは既に確定保存済み。ここが失敗してもユーザーの
  // データは失われないが、セッションの進行状況が古いまま残るためログには残す）
  const { error: sessionUpdateError } = await supabase
    .from('osarai_sessions')
    .update({
      messages: messages as unknown as never,
      customer_id: customerId,
      status: result.done ? 'done' : 'in_progress',
      resulting_interaction_id: resultingInteractionId,
    })
    .eq('id', sessionId)
    .eq('user_id', user.id);
  if (sessionUpdateError) {
    console.error('osarai_sessions update failed', sessionId, sessionUpdateError);
  }

  return json(
    {
      sessionId,
      customerId,
      next_question: result.next_question,
      done: result.done,
      extracted: result.extracted,
      interactionId: resultingInteractionId,
      customerName,
      isNewCustomer,
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
): Promise<
  | { customerId: string; interactionId: string; customerName: string; isNewCustomer: boolean }
  | { error: string }
> {
  const { supabase, orgId, authorId, extracted } = args;
  const now = new Date().toISOString();

  // 顧客が未指定なら抽出名で新規カード作成（おさらいからカード自動生成・§8-1）
  let customerId = args.customerId;
  let customerName = '新しく会った人';
  const isNewCustomer = !customerId;
  if (!customerId) {
    customerName = inferName(extracted) ?? '新しく会った人';
    const { data: c, error } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        owner_id: authorId,
        name: customerName,
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

  return { customerId, interactionId: interaction.id, customerName, isNewCustomer };
}

function joinList(v?: string[]): string | null {
  if (!v || v.length === 0) return null;
  return v.join(' / ');
}

// extracted.name を優先し、無ければ custom_fields に名前らしき項目があれば拾う（無ければ null）
function inferName(extracted: OsaraiExtracted): string | null {
  if (typeof extracted.name === 'string' && extracted.name.trim()) return extracted.name.trim();
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
