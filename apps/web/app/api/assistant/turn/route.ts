// 統合AIチャットの1ターン処理（2026-08-06 UI/UX刷新）。
// 「おさらい」「相談」「自分をおさらい」を1画面に統合したことに伴う新API。
// AIが発話から意図(record/consult/self)を判断し、1回のGemini呼び出しで
// 「返答」と「スケジュール/つながり/タスクの抽出」を同時に行う。
// ここでは一切保存せず、抽出はサーバー側でセッションに累積する。実際の保存は
// ユーザーが確認カードで編集を確定した後 /api/assistant/commit が行う（誤登録防止）。
import { NextResponse } from 'next/server';
import { buildAssistantPrompt, ASSISTANT_SYSTEM_PROMPT } from '@osarai/shared';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { getEntitlement } from '@/lib/entitlement';
import { formatUserProfile } from '@/lib/customer-context';
import { geminiJson, GEMINI_MODEL_DIALOGUE, type GeminiSchema } from '@/lib/gemini';
import { normalizeName } from '@/lib/assistant-persist';

export const runtime = 'nodejs';
export const maxDuration = 60;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

interface ExtractedPerson {
  name: string;
  matched_customer_id?: string | null;
  points?: string[];
  needs?: string[];
  next_actions?: string[];
  custom_fields?: Record<string, unknown>;
}
interface ExtractedSchedule {
  title: string;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  person_name?: string | null;
  location?: string | null;
  mode?: string | null;
}
interface ExtractedTask {
  title: string;
  due_date?: string | null;
  person_name?: string | null;
}
interface Extracted {
  people?: ExtractedPerson[];
  schedules?: ExtractedSchedule[];
  tasks?: ExtractedTask[];
  self_notes?: string[];
  self_fields?: Record<string, string>;
}
interface TurnResult {
  intent: 'record' | 'consult' | 'self' | 'unknown';
  reply: string | null;
  customer_ref?: {
    matched_id?: string | null;
    candidate_ids?: string[];
    mentioned_name?: string | null;
    needs_confirmation?: boolean;
  };
  extracted: Extracted;
  done: boolean;
}

const TURN_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['record', 'consult', 'self', 'unknown'] },
    reply: { type: 'string', nullable: true },
    customer_ref: {
      type: 'object',
      properties: {
        matched_id: { type: 'string', nullable: true },
        candidate_ids: { type: 'array', items: { type: 'string' } },
        mentioned_name: { type: 'string', nullable: true },
        needs_confirmation: { type: 'boolean' },
      },
    },
    extracted: {
      type: 'object',
      properties: {
        people: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              matched_customer_id: { type: 'string', nullable: true },
              points: { type: 'array', items: { type: 'string' } },
              needs: { type: 'array', items: { type: 'string' } },
              next_actions: { type: 'array', items: { type: 'string' } },
              custom_fields: {
                type: 'object',
                properties: {
                  products: { type: 'array', items: { type: 'string' } },
                  age: { type: 'string', nullable: true },
                  gender: { type: 'string', nullable: true },
                },
              },
            },
            required: ['name', 'points', 'needs', 'next_actions'],
          },
        },
        schedules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              date: { type: 'string' },
              start_time: { type: 'string', nullable: true },
              end_time: { type: 'string', nullable: true },
              person_name: { type: 'string', nullable: true },
              location: { type: 'string', nullable: true },
              mode: { type: 'string', nullable: true },
            },
            // start_time も必ず出力させる（nullable なので不明なら null）。required に入れないと
            // 「14時」と話しても時刻キーごと落ちて既定の10:00になってしまう。
            required: ['title', 'date', 'start_time'],
          },
        },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              due_date: { type: 'string', nullable: true },
              person_name: { type: 'string', nullable: true },
            },
            required: ['title'],
          },
        },
        self_notes: { type: 'array', items: { type: 'string' } },
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
      required: ['people', 'schedules', 'tasks', 'self_notes'],
    },
    done: { type: 'boolean' },
  },
  required: ['intent', 'reply', 'extracted', 'done'],
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

/** 抽出のターン間マージ。人物は正規化名、予定/タスクは タイトル+日付 をキーに統合する。 */
function mergeExtracted(base: Extracted, incoming?: Extracted): Extracted {
  if (!incoming) return base;
  const people = new Map<string, ExtractedPerson>();
  for (const p of [...(base.people ?? []), ...(incoming.people ?? [])]) {
    if (!p?.name?.trim()) continue;
    const key = normalizeName(p.name);
    const prev = people.get(key);
    people.set(key, {
      name: p.name,
      matched_customer_id: p.matched_customer_id ?? prev?.matched_customer_id ?? null,
      points: mergeList(prev?.points, p.points),
      needs: mergeList(prev?.needs, p.needs),
      next_actions: mergeList(prev?.next_actions, p.next_actions),
      custom_fields: { ...(prev?.custom_fields ?? {}), ...nonEmpty(p.custom_fields) },
    });
  }
  // 予定は「日付＋開始時刻」をキーにする。ターンごとに言い回しが変わっても
  // （「カフェで会う」→「カフェで面談」）同じ枠の予定が二重に登録されないようにする。
  const schedules = new Map<string, ExtractedSchedule>();
  for (const s of [...(base.schedules ?? []), ...(incoming.schedules ?? [])]) {
    if (!s?.title?.trim() || !s.date) continue;
    const key = `${s.date}|${s.start_time ?? ''}`;
    const prev = schedules.get(key);
    schedules.set(key, {
      ...s,
      // 後のターンで場所や相手が判明した場合は補完する（判明済みの情報を消さない）
      start_time: s.start_time ?? prev?.start_time ?? null,
      end_time: s.end_time ?? prev?.end_time ?? null,
      person_name: s.person_name ?? prev?.person_name ?? null,
      location: s.location ?? prev?.location ?? null,
      mode: s.mode ?? prev?.mode ?? null,
    });
  }
  // タスクはタイトルだけをキーにする（同じ用件が期限ありなしで二重に出るのを防ぐ）。
  // 後から期限が判明した場合は、期限ありの方を採用する。
  const tasks = new Map<string, ExtractedTask>();
  for (const t of [...(base.tasks ?? []), ...(incoming.tasks ?? [])]) {
    if (!t?.title?.trim()) continue;
    const key = normalizeName(t.title);
    const prev = tasks.get(key);
    tasks.set(key, {
      title: t.title,
      due_date: t.due_date ?? prev?.due_date ?? null,
      person_name: t.person_name ?? prev?.person_name ?? null,
    });
  }
  return {
    people: [...people.values()],
    schedules: [...schedules.values()],
    tasks: [...tasks.values()],
    self_notes: mergeList(base.self_notes, incoming.self_notes),
    self_fields: { ...(base.self_fields ?? {}), ...(nonEmpty(incoming.self_fields) as Record<string, string>) },
  };
}

function mergeList(a?: string[], b?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...(a ?? []), ...(b ?? [])]) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function nonEmpty<T extends Record<string, unknown>>(o?: T): Record<string, unknown> {
  if (!o) return {};
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (typeof v === 'string') return v.trim() !== '';
      if (Array.isArray(v)) return v.length > 0;
      return true;
    }),
  );
}

/** 累積した抽出を、確認カード（クライアント）が扱う形に変換する。日時はJSTとして解決する。 */
function toProposals(acc: Extracted, customers: { id: string; name: string }[], now: Date) {
  const people = (acc.people ?? []).map((p) => {
    // AIが既存idを返していればそれを、無ければ正規化名の一致で既存に寄せる（重複登録の防止）
    const matched =
      (p.matched_customer_id && customers.find((c) => c.id === p.matched_customer_id)?.id) ??
      customers.find((c) => normalizeName(c.name) === normalizeName(p.name))?.id ??
      null;
    return {
      customer_id: matched,
      name: p.name,
      points: p.points ?? [],
      needs: p.needs ?? [],
      next_actions: p.next_actions ?? [],
      custom_fields: p.custom_fields ?? {},
    };
  });
  const indexOfPerson = (name?: string | null) => {
    // 相手が明示されていなくても、話に出てきた人物が1人だけならその人の予定/タスクとして扱う
    // （「〇〇さんと会う約束をして、資料を送る」のような自然な話し方を取りこぼさない）。
    if (!name) return people.length === 1 ? 0 : null;
    const i = people.findIndex((p) => normalizeName(p.name) === normalizeName(name));
    return i >= 0 ? i : people.length === 1 ? 0 : null;
  };
  const schedules = (acc.schedules ?? []).map((s) => {
    const start = jstToIso(s.date, s.start_time ?? '10:00', now);
    const end = s.end_time ? jstToIso(s.date, s.end_time, now) : new Date(Date.parse(start) + 3600_000).toISOString();
    return {
      title: s.title,
      start_at: start,
      end_at: end,
      person_index: indexOfPerson(s.person_name),
      location: s.location ?? null,
      mode: s.mode ?? null,
      category: null as string | null,
    };
  });
  const tasks = (acc.tasks ?? []).map((t) => ({
    title: t.title,
    due_at: t.due_date ? jstToIso(t.due_date, '23:59', now) : null,
    person_index: indexOfPerson(t.person_name),
  }));
  return { people, schedules, tasks, self_notes: acc.self_notes ?? [], self_fields: acc.self_fields ?? {} };
}

/** 'YYYY-MM-DD' + 'HH:mm'（JST）を UTC の ISO 文字列にする。不正値は現在時刻にフォールバック。 */
function jstToIso(date: string, time: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return now.toISOString();
  const hh = t ? Number(t[1]) : 10;
  const mm = t ? Number(t[2]) : 0;
  // JST(+09:00)として解釈する
  const iso = `${m[1]}-${m[2]}-${m[3]}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;
  const d = new Date(iso);
  return Number.isNaN(+d) ? now.toISOString() : d.toISOString();
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
