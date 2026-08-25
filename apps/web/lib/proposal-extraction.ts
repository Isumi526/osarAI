// 発話/文字起こし → 「つながり/予定/タスク」抽出の共有ロジック。
// 元々 app/api/assistant/turn/route.ts に閉じていたが、会議録音(T0)からも同じ抽出を
// 1ショットで使うため純粋関数として切り出した（単一ソース化）。HTTPハンドラ側は
// これを import して使う。振る舞いは従来と同一（関数はそのまま移設）。
import type { GeminiSchema } from '@/lib/gemini';
import { normalizeName, type Proposals } from '@/lib/assistant-persist';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface ExtractedPerson {
  name: string;
  matched_customer_id?: string | null;
  points?: string[];
  needs?: string[];
  next_actions?: string[];
  custom_fields?: Record<string, unknown>;
}
export interface ExtractedSchedule {
  title: string;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  person_name?: string | null;
  location?: string | null;
  mode?: string | null;
}
export interface ExtractedTask {
  title: string;
  due_date?: string | null;
  person_name?: string | null;
}
export interface Extracted {
  people?: ExtractedPerson[];
  schedules?: ExtractedSchedule[];
  tasks?: ExtractedTask[];
  self_notes?: string[];
  self_fields?: Record<string, string>;
}
export interface TurnResult {
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

export const TURN_SCHEMA: GeminiSchema = {
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

/** 抽出のターン間マージ。人物は正規化名、予定/タスクは タイトル+日付 をキーに統合する。 */
export function mergeExtracted(base: Extracted, incoming?: Extracted): Extracted {
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
  // 予定・タスクのタイトルは、統合前に人名を落としておく（「サンプル太郎さんに資料を送る」と
  // 「サンプル太郎さんに保険の提案資料を送る」が別物として残るのを防ぐ。相手はperson_nameで持つ）。
  const mergedNames = [...people.values()].map((p) => p.name);
  const cleanTitle = (t: string) => stripPersonFromTitle(t, mergedNames);

  // 予定は「日付＋開始時刻」をキーにする。ターンごとに言い回しが変わっても
  // （「カフェで会う」→「カフェで面談」）同じ枠の予定が二重に登録されないようにする。
  const schedules = new Map<string, ExtractedSchedule>();
  for (const s of [...(base.schedules ?? []), ...(incoming.schedules ?? [])]) {
    if (!s?.title?.trim() || !s.date) continue;
    const key = `${s.date}|${s.start_time ?? ''}`;
    const prev = schedules.get(key);
    schedules.set(key, {
      ...s,
      title: cleanTitle(s.title),
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
  // タスクも言い換えの重複を潰す（「資料を送る」「保険の提案資料を送る」＝同じ用件）。
  // 一方が他方を含むなら同一とみなし、より具体的な（長い）タイトルを残す。
  const tasks: ExtractedTask[] = [];
  for (const t0 of [...(base.tasks ?? []), ...(incoming.tasks ?? [])]) {
    if (!t0?.title?.trim()) continue;
    const t = { ...t0, title: cleanTitle(t0.title) };
    const key = compactKey(t.title);
    const i = tasks.findIndex((x) => {
      const k = compactKey(x.title);
      return k === key || k.includes(key) || key.includes(k);
    });
    if (i === -1) {
      tasks.push({ title: t.title, due_date: t.due_date ?? null, person_name: t.person_name ?? null });
    } else {
      const prev = tasks[i]!;
      tasks[i] = {
        title: t.title.length > prev.title.length ? t.title : prev.title,
        due_date: t.due_date ?? prev.due_date ?? null,
        person_name: t.person_name ?? prev.person_name ?? null,
      };
    }
  }
  return {
    people: [...people.values()],
    schedules: [...schedules.values()],
    tasks,
    self_notes: mergeList(base.self_notes, incoming.self_notes),
    self_fields: { ...(base.self_fields ?? {}), ...(nonEmpty(incoming.self_fields) as Record<string, string>) },
  };
}

/**
 * 要点・ニーズ・次アクションのターン間マージ。
 * Geminiは同じ内容をターンごとに言い換えて返すため（「交流会で話をした」「交流会で話した」）、
 * 完全一致だけの除去では確認カードが重複だらけになる。正規化した上で、片方がもう片方を
 * 含む場合は同一とみなし、情報量の多い（長い）方を残す。
 */
function mergeList(a?: string[], b?: string[]): string[] {
  const out: string[] = [];
  for (const v of [...(a ?? []), ...(b ?? [])]) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) continue;
    const key = compactKey(t);
    if (!key) continue;
    const dupIndex = out.findIndex((x) => {
      const k = compactKey(x);
      return k === key || k.includes(key) || key.includes(k);
    });
    if (dupIndex === -1) out.push(t);
    else if (t.length > out[dupIndex]!.length) out[dupIndex] = t; // 詳しい方を残す
  }
  return out;
}

/** 人名を落とした後のタイトルで、もう一度重複を統合する（より具体的な方を残す）。 */
function dedupeTitles<T extends { title: string; due_at?: string | null; person_index: number | null }>(items: T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const key = compactKey(item.title);
    const i = out.findIndex((x) => {
      const k = compactKey(x.title);
      return k === key || k.includes(key) || key.includes(k);
    });
    if (i === -1) out.push(item);
    else if (item.title.length > out[i]!.title.length) {
      out[i] = { ...item, due_at: item.due_at ?? out[i]!.due_at, person_index: item.person_index ?? out[i]!.person_index };
    }
  }
  return out;
}

/**
 * 言い回しの揺れを吸収する比較キー。
 * 「不動産も扱っている」と「不動産を扱っている」、「カフェで会う」と「カフェで会う（保険の提案）」
 * のような差は同一とみなしたいので、括弧内の補足・助詞・記号・語尾を落として比べる。
 */
function compactKey(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '') // 括弧の補足は無視する
    .replace(/[\s、。，．・「」『』〜~!！?？]/g, '')
    .replace(/(をした|をする|した|する|です|ます|になった|になる|予定|することになった)$/u, '')
    .replace(/[をもがはにへとでやのか]/g, '') // 助詞違いだけの重複を潰す
    .toLowerCase();
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
export function toProposals(acc: Extracted, customers: { id: string; name: string }[], now: Date): Proposals {
  const people = (acc.people ?? []).map((p0) => {
    // 抽出名に「さん」等が付くと一覧表示で「サンプル太郎さんさん」になるため落とす
    const p = { ...p0, name: stripHonorific(p0.name) };
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
  const personNames = people.map((p) => p.name);
  const schedules = (acc.schedules ?? []).map((s) => {
    const start = jstToIso(s.date, s.start_time ?? '10:00', now);
    const end = s.end_time ? jstToIso(s.date, s.end_time, now) : new Date(Date.parse(start) + 3600_000).toISOString();
    return {
      title: stripPersonFromTitle(s.title, personNames),
      start_at: start,
      end_at: end,
      person_index: indexOfPerson(s.person_name),
      location: s.location ?? null,
      mode: s.mode ?? null,
      category: null as string | null,
    };
  });
  const tasks = dedupeTitles(
    (acc.tasks ?? []).map((t) => ({
      title: stripPersonFromTitle(t.title, personNames),
      due_at: t.due_date ? jstToIso(t.due_date, '23:59', now) : null,
      person_index: indexOfPerson(t.person_name),
    })),
  );
  return { people, schedules, tasks, self_notes: acc.self_notes ?? [], self_fields: acc.self_fields ?? {} };
}

/**
 * 予定/タスクのタイトルに紛れ込んだ人物名を落とす（相手はリレーションで持つため）。
 * 「サンプル太郎さんとカフェで会う」→「カフェで会う」 / 「サンプル太郎さんに資料を送る」→「資料を送る」。
 * プロンプトでも指示しているが、揺れるのでサーバー側でも正規化する。
 */
function stripPersonFromTitle(title: string, names: string[]): string {
  let out = title.trim();
  for (const n of names) {
    const base = stripHonorific(n);
    if (!base) continue;
    const honorific = '(?:さん|様|さま|氏|くん|ちゃん)?';
    out = out
      .replace(new RegExp(`^${escapeRegExp(base)}${honorific}(?:と|に|への|へ|の|と の)\\s*`, 'u'), '')
      .replace(new RegExp(`${escapeRegExp(base)}${honorific}(?:と|に|への|へ)`, 'gu'), '');
  }
  return out.trim() || title.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 表示側が「〇〇さん」と付けるため、保存する名前からは敬称を落とす。 */
function stripHonorific(name: string): string {
  return name.trim().replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '').trim() || name.trim();
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
