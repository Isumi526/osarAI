// AI戦略相談（§8-3）。scope=all は全顧客サマリ、scope=customer は対象顧客の履歴を
// コンテキスト化して Gemini に相談 → 回答。会話は ai_chats / ai_chat_messages に保存。
// コスト優先で Flash-Lite（§8 末尾）。データが薄い初期は一般営業ナレッジで補う。
import { NextResponse } from 'next/server';
import { buildAdvicePrompt, ADVICE_SYSTEM_PROMPT, jstMonthStartUtc, type ChatScope, type AiSummary } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { geminiText, GEMINI_MODEL_LITE } from '@/lib/gemini';

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
    .select('org_id')
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
  const systemAndData = buildAdvicePrompt({ scope, data });
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

type SB = import('@supabase/supabase-js').SupabaseClient<
  import('@osarai/shared/database.types').Database
>;

async function buildContext(
  supabase: SB,
  scope: ChatScope,
  customerId: string | null,
): Promise<string> {
  if (scope === 'customer' && customerId) {
    const { data: c } = await supabase
      .from('customers')
      .select('name, temperature, needs, last_met_at, custom_fields')
      .eq('id', customerId)
      .maybeSingle();
    if (!c) return 'データなし';
    const { data: ix } = await supabase
      .from('interactions')
      .select('source, met_at, ai_summary, raw_text')
      .eq('customer_id', customerId)
      .order('met_at', { ascending: false, nullsFirst: false })
      .limit(10);
    const timeline = (ix ?? [])
      .map((r) => {
        const s = r.ai_summary as AiSummary | null;
        const when = r.met_at ? new Date(r.met_at).toLocaleDateString('ja-JP') : '日付不明';
        const bodyText = s?.points?.length ? s.points.join('、') : (r.raw_text ?? '').slice(0, 120);
        const next = s?.next_actions?.length ? ` / 次: ${s.next_actions.join('、')}` : '';
        return `- ${when}: ${bodyText}${next}`;
      })
      .join('\n');
    return [
      `名前: ${c.name}`,
      `温度感: ${c.temperature ?? '未設定'}`,
      `ニーズ: ${c.needs ?? '未把握'}`,
      `最終接触: ${c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録'}`,
      `履歴:\n${timeline || '（履歴なし）'}`,
    ].join('\n');
  }

  // scope=all: 顧客一覧サマリ（RLS で自分の担当分のみ）
  const { data: customers } = await supabase
    .from('customers')
    .select('name, temperature, needs, last_met_at, status')
    .eq('status', 'active')
    .order('last_met_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (!customers || customers.length === 0) return 'データなし（まだ顧客が登録されていません）';
  return customers
    .map((c) => {
      const when = c.last_met_at ? new Date(c.last_met_at).toLocaleDateString('ja-JP') : '未記録';
      return `- ${c.name}（温度: ${c.temperature ?? '?'} / ニーズ: ${c.needs ?? '未把握'} / 最終接触: ${when}）`;
    })
    .join('\n');
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
