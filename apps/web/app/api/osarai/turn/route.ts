// おさらい対話 1ターン処理（★コア・§8-1）。
// フロー: ユーザー発話 → Gemini が(抽出 + 次の質問 + done)を返す → 対話を保存。
// done になったら抽出を統合して interactions(source=ai_dialogue) を作成し、
// customers を更新（無ければ抽出した名前で新規作成）、osarai_sessions を done に。
//
// 高速化(議事録『review』回答A)の実装方針: Geminiは各ターンで対話履歴全体から
// 毎回フル再抽出するため(インクリメンタルな抽出キャッシュは無い)、完了操作時にAI呼び出し
// 自体を短縮する余地はない。一方、完了時にのみ発生するDB書き込み(customer作成/更新・
// 温度感再計算・interaction作成・session更新)は互いに独立な部分を並列化できるため、
// 独立クエリ(契約ゲート+profile取得・温度感再計算+interaction作成)をPromise.allで
// 並列化した。「対話中に顧客/interactionレコードを先行作成しておき完了時は差分更新のみ」
// という案も検討したが、対話を最後まで終えないユーザーがいた場合に孤児レコードが残る
// リスクがあり、既存アーキテクチャ(完了時に確定保存)を大きく変える割に効果が限定的
// (支配的なレイテンシはGemini API呼び出し自体でDB書き込みは数十ms単位)と判断し見送った。
import { NextResponse } from 'next/server';
import {
  buildOsaraiPrompt,
  OSARAI_SYSTEM_PROMPT,
  computeAutoTemperature,
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
  'custom_fields: その他特記事項(キー値。products: 相手が扱っている商品(文字列配列・判明していれば), ' +
  'age: 相手の年齢(文字列・判明していれば), gender: 相手の性別(文字列・判明していれば)も' +
  'このキーに含めてよい), name: 相手の名前(判明していれば), ' +
  'self_fields: 会話中にユーザー自身について言及があった場合の構造化情報' +
  '(job/products/age/gender/background/goal。相手ではなく本人について。言及が無ければ含めない)}';

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
        // Geminiのresponse Schemaは宣言されていないプロパティを出力できないため、
        // custom_fieldsに含めたいキーは明示的に列挙する必要がある(properties:{}のままだと常に空になる)。
        custom_fields: {
          type: 'object',
          properties: {
            products: { type: 'array', items: { type: 'string' } },
            age: { type: 'string', nullable: true },
            gender: { type: 'string', nullable: true },
          },
        },
        name: { type: 'string', nullable: true },
        self_fields: {
          type: 'object',
          properties: {
            age: { type: 'string', nullable: true },
            gender: { type: 'string', nullable: true },
            job: { type: 'string', nullable: true },
            products: { type: 'string', nullable: true },
            background: { type: 'string', nullable: true },
            goal: { type: 'string', nullable: true },
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
    sessionId?: string;
    customerId?: string | null;
    message?: string;
    forceEnd?: boolean;
  };
  const forceEnd = body.forceEnd === true;
  const message = (body.message ?? '').trim();
  if (!message && !forceEnd) return json({ error: 'message required' }, 400);

  // 契約ゲート（§16 未契約/解約は機能制限）＋ 自分の org_id（RLS の insert に必要）。
  // 互いに独立したクエリのため並列化する（高速化・議事録『review』回答A）。
  const [ent, profileRes] = await Promise.all([
    getEntitlement(supabase, user.id),
    supabase.from('profiles').select('org_id').eq('id', user.id).maybeSingle(),
  ]);
  if (!ent.active) {
    return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  }
  const profile = profileRes.data;
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
        temperature: 'cold', // 新規は履歴が無いためcoldから開始。直後にlast_met_atを踏まえ再計算する。
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

  // 温度感の再計算・interaction作成・自分自身の情報のプロフィール反映は互いに独立した
  // 書き込みのため並列化する（高速化・議事録『review』回答A）。
  const selfFields = cleanSelfFields(extracted.self_fields);
  const [, , { data: interaction, error }] = await Promise.all([
    recomputeTemperature(supabase, customerId, now),
    selfFields ? supabase.rpc('merge_user_profile_fields', { new_notes: [], new_fields: selfFields }) : Promise.resolve(),
    supabase
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
      .single(),
  ]);
  if (error || !interaction) return { error: 'interaction create failed' };

  return { customerId, interactionId: interaction.id, customerName, isNewCustomer };
}

function joinList(v?: string[]): string | null {
  if (!v || v.length === 0) return null;
  return v.join(' / ');
}

// 会話中にユーザー自身について言及があった場合の構造化情報(self_fields)から、
// 空文字/未言及を除いたものだけを返す。1件も無ければnull(RPC呼び出し自体をスキップ)。
function cleanSelfFields(fields?: OsaraiExtracted['self_fields']): Record<string, string> | null {
  if (!fields) return null;
  const cleaned = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.trim().length > 0),
  );
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

// 温度感(手動設定UI廃止・議事録『review』回答A)を、直近接触日(=now・直前に保存済み)と
// 直近60日の予定件数(私用除く)から再計算して保存する。
async function recomputeTemperature(
  supabase: PersistArgs['supabase'],
  customerId: string,
  lastMetAt: string,
): Promise<void> {
  const { data: current } = await supabase.from('customers').select('temperature').eq('id', customerId).maybeSingle();
  const sixtyDaysAgo = new Date(Date.parse(lastMetAt) - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('schedules')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .gte('start_at', sixtyDaysAgo)
    .or('category.neq.私用,category.is.null');
  const temperature = computeAutoTemperature({ lastMetAt, recentMeetingCount: count ?? 0 });
  if (temperature === current?.temperature) return;
  await supabase.from('customers').update({ temperature }).eq('id', customerId);
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
