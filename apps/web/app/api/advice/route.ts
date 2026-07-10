// AI戦略相談（§8-3）。scope=all は全顧客サマリ、scope=customer は対象顧客の履歴を
// コンテキスト化して Gemini に相談 → 回答。会話は ai_chats / ai_chat_messages に保存。
// コスト優先で Flash-Lite（§8 末尾）。データが薄い初期は一般営業ナレッジで補う。
import { NextResponse } from 'next/server';
import { buildAdvicePrompt, ADVICE_SYSTEM_PROMPT, jstMonthStartUtc, type ChatScope } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { geminiText, GEMINI_MODEL_LITE } from '@/lib/gemini';
import { buildContext, formatUserProfile } from '@/lib/customer-context';

export const runtime = 'nodejs';
// lib/gemini.ts のリトライが最悪ケースでGemini呼び出しを複数回行うため余裕を持たせる
export const maxDuration = 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { supabase, user } = ctx;

  const body = (await req.json()) as {
    chatId?: string;
    scope?: ChatScope;
    customerId?: string | null;
    message?: string;
  };
  const message = (body.message ?? '').trim();
  if (!message) return json({ error: 'message required' }, 400);
  const scope: ChatScope = body.scope === 'customer' ? 'customer' : 'all';
  const customerId = scope === 'customer' ? body.customerId ?? null : null;
  if (scope === 'customer' && !customerId) return json({ error: 'customerId required' }, 400);

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id, user_profile')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) return json({ error: 'profile not found' }, 400);
  const orgId = profile.org_id;

  // 契約ゲート（§16）＋ プラン別 AI相談 月間上限（§11 Light=10回）
  const ent = await getEntitlement(supabase, user.id);
  if (!ent.active) {
    return json({ error: 'subscription_required', message: '契約が必要です（Webで登録）' }, 402);
  }
  const limit = ent.def?.aiAdviceLimit ?? null;
  if (limit != null) {
    // A5対策: サーバー(Vercel)はUTCで動くため、素の new Date().setHours(0,0,0,0) は
    // UTC深夜0時になりJSTの月初と最大9時間ずれる（月初/月末付近でカウント境界が狂う）。
    // JST固定で「今月」を判定する。
    const monthStart = jstMonthStartUtc();
    // RLS により自分のチャットのメッセージのみ数える
    const { count } = await supabase
      .from('ai_chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'user')
      .gte('created_at', monthStart.toISOString());
    if ((count ?? 0) >= limit) {
      return json(
        { error: 'advice_limit_reached', message: `今月のAI相談は上限(${limit}回)に達しました。上位プランで無制限になります。` },
        429,
      );
    }
  }

  // --- チャット取得 or 新規作成 ---
  let chatId = body.chatId;
  if (chatId) {
    const { data: chat } = await supabase
      .from('ai_chats')
      .select('id')
      .eq('id', chatId)
      .maybeSingle();
    if (!chat) return json({ error: 'chat not found' }, 404);
  } else {
    const { data: created, error } = await supabase
      .from('ai_chats')
      .insert({
        org_id: orgId,
        user_id: user.id,
        scope,
        customer_id: customerId,
        title: message.slice(0, 40),
      })
      .select('id')
      .single();
    if (error || !created) return json({ error: 'chat create failed' }, 500);
    chatId = created.id;
  }

  // ユーザー発話を保存
  await supabase.from('ai_chat_messages').insert({ chat_id: chatId, role: 'user', content: message });

  // これまでの会話履歴（継続性のため）
  const { data: history } = await supabase
    .from('ai_chat_messages')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  // --- 顧客データをコンテキスト化 ---
  const data = await buildContext(supabase, scope, customerId);
  const userProfile = formatUserProfile(profile.user_profile as Record<string, unknown> | null);
  const systemAndData = buildAdvicePrompt({ scope, data, userProfile });
  const convo = (history ?? [])
    .map((m) => `${m.role === 'user' ? 'ユーザー' : 'コーチ'}: ${m.content}`)
    .join('\n');
  const prompt = `${systemAndData}\n\n【これまでの相談】\n${convo}\n\nコーチ:`;

  // --- Gemini ---
  let reply: string;
  try {
    reply = await geminiText(prompt, {
      model: GEMINI_MODEL_LITE,
      system: ADVICE_SYSTEM_PROMPT,
      temperature: 0.6,
    });
  } catch (e) {
    return json({ error: 'ai failed', detail: String(e) }, 502);
  }

  await supabase.from('ai_chat_messages').insert({ chat_id: chatId, role: 'assistant', content: reply });

  return json({ chatId, reply }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
