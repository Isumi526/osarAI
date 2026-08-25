// 統合AIチャットの1ターン処理（2026-08-06 UI/UX刷新）。
// 「おさらい」「相談」「自分をおさらい」を1画面に統合したことに伴う新API。
// AIが発話から意図(record/consult/self)を判断し、1回のGemini呼び出しで
// 「返答」と「スケジュール/つながり/タスクの抽出」を同時に行う。
// ここでは一切保存せず、抽出はサーバー側でセッションに累積する。実際の保存は
// ユーザーが確認カードで編集を確定した後 /api/assistant/commit が行う（誤登録防止）。
// 抽出スキーマ/整形ロジックは lib/proposal-extraction に切り出し、会議録音(T0)と共有する。
import { NextResponse } from 'next/server';
import { buildAssistantPrompt, ASSISTANT_SYSTEM_PROMPT } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { formatUserProfile } from '@/lib/customer-context';
import { geminiJson, GEMINI_MODEL_DIALOGUE } from '@/lib/gemini';
import {
  TURN_SCHEMA,
  mergeExtracted,
  toProposals,
  type ChatMessage,
  type Extracted,
  type TurnResult,
} from '@/lib/proposal-extraction';

export const runtime = 'nodejs';
export const maxDuration = 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json()) as {
    sessionId?: string;
    message?: string;
    forceEnd?: boolean;
    confirmedCustomerId?: string | null;
  };
  const forceEnd = body.forceEnd === true;
  const message = (body.message ?? '').trim();
  if (!message && !forceEnd) return json({ error: 'message required' }, 400);

  const [ent, profileRes] = await Promise.all([
    getEntitlement(supabase, user.id),
    supabase.from('profiles').select('org_id, user_profile').eq('id', user.id).maybeSingle(),
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
  let accumulated: Extracted = {};

  if (sessionId) {
    const { data: sess, error } = await supabase
      .from('assistant_sessions')
      .select('id, messages, accumulated, status')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !sess) return json({ error: 'session not found' }, 404);
    messages = (sess.messages as ChatMessage[]) ?? [];
    accumulated = (sess.accumulated as Extracted) ?? {};
  } else if (forceEnd) {
    return json({ error: 'no session to end' }, 400);
  } else {
    const { data: created, error } = await supabase
      .from('assistant_sessions')
      .insert({ org_id: orgId, user_id: user.id, messages: [] })
      .select('id')
      .single();
    if (error || !created) return json({ error: 'session create failed' }, 500);
    sessionId = created.id;
  }

  if (message) messages.push({ role: 'user', content: message });
  if (forceEnd && messages.length === 0) return json({ error: 'nothing to summarize yet' }, 400);

  // --- コンテキスト（顧客名簿・商品名簿・自分のプロフィール） ---
  const [customersRes, agencyRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, name, relation_type, needs')
      .eq('owner_id', user.id)
      .eq('status', 'active')
      .limit(100),
    supabase.from('agency_products').select('name').limit(50),
  ]);
  const customers = customersRes.data ?? [];
  const customerRoster = customers
    .map((c) => `- id=${c.id} 名前=${c.name}${c.relation_type ? ` 区分=${c.relation_type}` : ''}${c.needs ? ` ニーズ=${c.needs}` : ''}`)
    .join('\n');

  const userProfile = (profile.user_profile as Record<string, unknown> | null) ?? {};
  const ownProducts = Array.isArray(userProfile.products)
    ? (userProfile.products as { name?: string }[]).map((p) => p?.name).filter(Boolean)
    : [];
  const productRoster = [...ownProducts, ...(agencyRes.data ?? []).map((p) => p.name)]
    .map((n) => `- ${n}`)
    .join('\n');

  const notes = Array.isArray(userProfile.notes) ? (userProfile.notes as string[]).slice(-30) : [];
  const userContext = [formatUserProfile(userProfile), notes.length ? `これまでの気づき:\n${notes.map((n) => `- ${n}`).join('\n')}` : '']
    .filter(Boolean)
    .join('\n');

  const now = new Date();
  const nowLabel = now.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const history = messages.map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
  const prompt = buildAssistantPrompt({ now: nowLabel, customerRoster, productRoster, userContext, history });

  let result: TurnResult;
  try {
    result = await geminiJson<TurnResult>(prompt, TURN_SCHEMA, {
      model: GEMINI_MODEL_DIALOGUE,
      system: ASSISTANT_SYSTEM_PROMPT,
    });
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e) }, 502);
  }

  if (forceEnd) result = { ...result, done: true };

  // 抽出をセッションに累積（Geminiがターンによって項目を落としても失わない・0025と同じ設計）
  accumulated = mergeExtracted(accumulated, result.extracted);

  if (result.reply) messages.push({ role: 'assistant', content: result.reply });

  // 人物が曖昧な時の確認（勝手に断定しない）。候補は実在idのみ通す（幻覚ガード）。
  const validIds = new Set(customers.map((c) => c.id));
  const ref = result.customer_ref;
  let customerQuestion: { question: string; candidates: { id: string; name: string }[]; allow_new: boolean } | null = null;
  if (ref?.needs_confirmation && !body.confirmedCustomerId) {
    const candidates = (ref.candidate_ids ?? [])
      .filter((id) => validIds.has(id))
      .map((id) => ({ id, name: customers.find((c) => c.id === id)!.name }))
      .slice(0, 4);
    if (candidates.length > 0) {
      customerQuestion = {
        question:
          candidates.length === 1
            ? `もしかして${candidates[0]!.name}さんのお話ですか？`
            : 'どなたのお話でしょうか？',
        candidates,
        allow_new: true,
      };
    }
  }

  await supabase
    .from('assistant_sessions')
    .update({
      messages: messages as unknown as never,
      accumulated: accumulated as unknown as never,
      status: result.done ? 'reviewing' : 'in_progress',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .eq('user_id', user.id);

  return json(
    {
      sessionId,
      reply: result.reply,
      intent: result.intent,
      customer_question: customerQuestion,
      proposals: result.done ? toProposals(accumulated, customers, now) : null,
      done: result.done,
    },
    200,
  );
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
