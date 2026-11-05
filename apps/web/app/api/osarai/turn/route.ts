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
  personMemo,
  personWantsToMeet,
  customerMemo,
  splitCardNote,
  type OsaraiTurnResult,
  type OsaraiExtracted,
} from '@osarai/shared';
import { mergeMemo } from '@/lib/proposal-extraction';
import { mergeArrayFields } from '@/lib/assistant-persist';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { geminiJson, GEMINI_MODEL_DIALOGUE, type GeminiSchema } from '@/lib/gemini';

export const runtime = 'nodejs';
// lib/gemini.ts のリトライ+モデルフォールバックが最悪ケースでGemini呼び出しを複数回行うため余裕を持たせる
export const maxDuration = 60;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// 埋めたい顧客カード項目（プロンプトに渡す説明）
// 2026-11-03（0035）から要点/ニーズ/次アクション/custom_fields に分けず、自由記述のメモ1本で受け取る。
const CARD_SCHEMA_DESC =
  '{memo: その回に話した内容・相手の近況や困りごと・約束したことを1本にまとめた文章, ' +
  'card_note: カードのメモに足す、この人自身について新しく分かったこと(扱っている商品・年齢・性別なども。' +
  '既存データの memo にある内容と、memo に書いた文は書かない。無ければ空文字), ' +
  'wants_to_meet: 相手がつながりたい人・紹介してほしい人物像(配列), ' +
  'temperature: 見込み温度(hot/warm/cold), name: 相手の名前(判明していれば), ' +
  'self_fields: 会話中にユーザー自身について言及があった場合の構造化情報' +
  '(job/products/age/gender/background/goal。相手ではなく本人について。言及が無ければ含めない)}';

// Gemini に強制する応答スキーマ（OsaraiTurnResult に対応）
const TURN_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    extracted: {
      type: 'object',
      properties: {
        // memo / wants_to_meet は毎ターン必ず出力させる（requiredで強制）。Geminiはターンによって
        // キーごと省略することがあるため（旧 custom_fields で商品/年齢/性別が丸ごと失われた件と同じ対策）。
        memo: { type: 'string' },
        card_note: { type: 'string' },
        wants_to_meet: { type: 'array', items: { type: 'string' } },
        temperature: { type: 'string', enum: ['hot', 'warm', 'cold'], nullable: true },
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
      required: ['memo', 'card_note', 'wants_to_meet'],
    },
    next_question: { type: 'string', nullable: true },
    done: { type: 'boolean' },
    end_reason: { type: 'string', enum: ['user_request', 'time_up', 'enough'], nullable: true },
  },
  required: ['extracted', 'next_question', 'done'],
};

// 残り時間があるのにAIが早期終了(done=true)した場合に、対話を継続させるための代替質問。
// プロンプト遵守が揺らいだ時の決定的なフォールバック（AC1: 時間内はAI側から終わらせない）。
const CONTINUE_FALLBACK_QUESTION =
  '他にも印象に残ったことや、話しておきたいことはありますか？😊';

// 残り30秒以下は「実質時間切れ」として通常のdone判定を許容する（直後にタイマーが切れるため）
const EARLY_END_GUARD_MIN_SEC = 30;

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
    /** クライアントのタイマー残り秒数。時間がある間はAI側から終了させない（早期終了防止） */
    remainingSec?: number | null;
  };
  const forceEnd = body.forceEnd === true;
  const remainingSec = typeof body.remainingSec === 'number' ? body.remainingSec : null;
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
  // 対話中に判明した内容のセッション累積（0025）。Geminiは毎ターン履歴全体から再抽出するが、
  // ターンによって一部の項目を落として返すため、最終ターンの結果だけを保存すると先に判明して
  // いた情報（メモの一部の行・つながりたい人）が失われる。
  // ここへ都度マージして保持する。
  let accumulated: AccumulatedExtraction = {};

  if (sessionId) {
    const { data: sess, error } = await supabase
      .from('osarai_sessions')
      .select('id, messages, customer_id, status, accumulated_fields')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !sess) return json({ error: 'session not found' }, 404);
    if (sess.status === 'done') return json({ error: 'session already done' }, 409);
    messages = (sess.messages as ChatMessage[]) ?? [];
    customerId = sess.customer_id ?? customerId;
    accumulated = (sess.accumulated_fields as AccumulatedExtraction | null) ?? {};
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
      .select('name, profile_notes, needs, temperature, custom_fields, last_met_at')
      .eq('id', customerId)
      .maybeSingle();
    // メモは新しい列（profile_notes）を優先し、無ければ旧項目から畳んだ文章を渡す（0035）
    if (c) {
      customerJson = JSON.stringify({
        name: c.name,
        memo: customerMemo(c) || null,
        wants_to_meet: personWantsToMeet({ custom_fields: c.custom_fields }),
        temperature: c.temperature,
        last_met_at: c.last_met_at,
      });
    }
  }

  // ユーザー発話を履歴に追加（forceEndで空発話の場合は追加しない）
  if (message) messages.push({ role: 'user', content: message });

  // --- Gemini 1ターン ---
  const history = messages.map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
  const timeContext =
    remainingSec !== null && remainingSec > 0
      ? `約${Math.floor(remainingSec / 60)}分${remainingSec % 60}秒（この時間いっぱいまで対話を続ける）`
      : undefined;
  const prompt = buildOsaraiPrompt({ schema: CARD_SCHEMA_DESC, customerJson, history, timeContext });

  let result: OsaraiTurnResult;
  try {
    result = await geminiJson<OsaraiTurnResult>(prompt, TURN_SCHEMA, {
      model: GEMINI_MODEL_DIALOGUE,
      system: OSARAI_SYSTEM_PROMPT,
    });
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e) }, 502);
  }
  // このターンの抽出を累積へマージし、以降は累積値を「対話で判明した情報」として扱う
  // （このターンで拾えなかった項目は既存の累積を消さない）。
  accumulated = mergeExtraction(accumulated, result.extracted);
  result = {
    ...result,
    extracted: {
      ...result.extracted,
      memo: accumulated.memo ?? '',
      card_note: accumulated.card_note ?? '',
      wants_to_meet: accumulated.wants_to_meet ?? [],
    },
  };

  // 明示的な終了操作は、Geminiの done 判定にかかわらずここまでの抽出内容で必ず完了させる
  if (forceEnd) {
    result = { ...result, done: true, next_question: null };
  }
  // 早期終了防止ガード: 残り時間があるのに、ユーザーの終了要望以外の理由で done になった場合は
  // 取り消して対話を継続させる（プロンプト遵守が揺らいでもAC1をサーバー側で決定的に担保する）。
  if (
    !forceEnd &&
    result.done &&
    remainingSec !== null &&
    remainingSec > EARLY_END_GUARD_MIN_SEC &&
    result.end_reason !== 'user_request'
  ) {
    result = {
      ...result,
      done: false,
      end_reason: null,
      next_question: result.next_question ?? CONTINUE_FALLBACK_QUESTION,
    };
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
    // 確認画面の編集欄には、カードと重ならない実際の要約を見せる（編集保存で同じ文が戻らないように）
    result = { ...result, extracted: { ...result.extracted, memo: persisted.summary } };
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
      accumulated_fields: accumulated as unknown as never,
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
  | { customerId: string; interactionId: string; customerName: string; isNewCustomer: boolean; summary: string }
  | { error: string }
> {
  const { supabase, orgId, authorId, extracted } = args;
  const now = new Date().toISOString();

  // 顧客が未指定なら抽出名で新規カード作成（おさらいからカード自動生成・§8-1）
  let customerId = args.customerId;
  let customerName = '新しく会った人';
  const isNewCustomer = !customerId;
  let summary = (extracted.memo ?? '').trim();
  const wants = extracted.wants_to_meet ?? [];
  if (!customerId) {
    customerName = inferName(extracted) ?? '新しく会った人';
    const split = splitCardNote({ existing: '', cardNote: extracted.card_note, memo: summary });
    summary = split.summary;
    const { data: c, error } = await supabase
      .from('customers')
      .insert({
        org_id: orgId,
        owner_id: authorId,
        name: customerName,
        profile_notes: split.additions || null,
        temperature: 'cold', // 新規は履歴が無いためcoldから開始。直後にlast_met_atを踏まえ再計算する。
        custom_fields: (wants.length ? { wants_to_meet: wants } : {}) as never,
        last_met_at: now,
      })
      .select('id')
      .single();
    if (error || !c) return { error: 'customer create failed' };
    customerId = c.id;
  } else {
    // つながりたい人（配列）は既存に追記してアトミックにマージする（上書きすると前回までの蓄積が消える）。
    // 旧 needs / custom_fields の商品・年齢等には書かない（0035）。
    const { data: cur } = await supabase
      .from('customers')
      .select('profile_notes, needs, custom_fields')
      .eq('id', customerId)
      .maybeSingle();
    const mergedFields = wants.length
      ? mergeArrayFields((cur?.custom_fields as Record<string, unknown> | null) ?? {}, { wants_to_meet: wants })
      : null;
    // カードのメモには新しく分かったことだけを足す（0036）
    const split = splitCardNote({ existing: cur ? customerMemo(cur) : '', cardNote: extracted.card_note, memo: summary });
    summary = split.summary;
    await Promise.all([
      mergedFields
        ? supabase.rpc('merge_customer_custom_fields', {
            target_customer_id: customerId,
            new_fields: mergedFields as never,
          })
        : Promise.resolve(),
      split.additions
        ? supabase.rpc('append_customer_profile_notes', { target_customer_id: customerId, addition: split.additions })
        : Promise.resolve(),
      supabase
        .from('customers')
        .update({ last_met_at: now, updated_at: now })
        .eq('id', customerId),
    ]);
  }
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
        // その回の要約は自由記述1本（0035）。ai_summary（旧 points/needs/next_actions）には書かない
        summary: summary || null,
        met_at: now,
      })
      .select('id')
      .single(),
  ]);
  if (error || !interaction) return { error: 'interaction create failed' };

  return { customerId, interactionId: interaction.id, customerName, isNewCustomer, summary };
}

// セッション(osarai_sessions.accumulated_fields・0025)に保持する累積抽出の形。
// 0035 以降は memo / wants_to_meet。旧キーは途中のセッションの読み取り用（personMemo で畳む）。
interface AccumulatedExtraction {
  memo?: string;
  card_note?: string;
  wants_to_meet?: string[];
  /** @deprecated 旧形式 */
  custom_fields?: Record<string, unknown>;
  /** @deprecated 旧形式 */
  points?: string[];
  /** @deprecated 旧形式 */
  needs?: string[];
  /** @deprecated 旧形式 */
  next_actions?: string[];
}

// 対話で判明した内容のターン間マージ。メモは行単位の和集合、つながりたい人は配列の和集合にする
// （そのターンで拾えなかった行・項目で、既に判明している内容を消さないため）。
function mergeExtraction(base: AccumulatedExtraction, incoming?: OsaraiExtracted): AccumulatedExtraction {
  if (!incoming) return base;
  const wants = [...personWantsToMeet(base)];
  for (const w of personWantsToMeet(incoming)) if (!wants.includes(w)) wants.push(w);
  return {
    memo: mergeMemo(personMemo(base), personMemo(incoming)),
    card_note: mergeMemo(base.card_note ?? '', incoming.card_note ?? ''),
    wants_to_meet: wants,
  };
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

// extracted.name を優先し、無ければ（旧形式の）custom_fields に名前らしき項目があれば拾う（無ければ null）
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
