// 自由記述メモ（2026-11-03 人判断「進める」・migration 0035）。
// つながり・自分の情報を「要点/ニーズ/次アクション/custom_fields」に分けず、メモ1本で持つ。
// 新しい列（customers.profile_notes / interactions.summary / profiles.profile_text）を先に読み、
// 空なら旧項目から同じ書式の文章に畳んで見せる（0035 の埋め戻しと同じ書式。旧データの読み取り経路）。

/** 旧 custom_fields の表示名。wants_to_meet はマッチング用に構造のまま残すのでメモに畳まない。 */
const LEGACY_FIELD_LABEL: Record<string, string> = {
  age: '年齢',
  gender: '性別',
  products: '扱っている商品',
};

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x))).filter(Boolean).join('、');
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
}

/** 旧 customers.needs ＋ custom_fields を、メモの文章に畳む（0035 の埋め戻しと同じ書式）。 */
export function legacyCustomerMemo(c: { needs?: string | null; custom_fields?: unknown }): string {
  const lines: string[] = [];
  const needs = (c.needs ?? '').trim();
  if (needs) lines.push(`ニーズ: ${needs}`);
  const cf = c.custom_fields && typeof c.custom_fields === 'object' && !Array.isArray(c.custom_fields)
    ? (c.custom_fields as Record<string, unknown>)
    : {};
  for (const k of ['age', 'gender', 'products']) {
    const v = str(cf[k]);
    if (v) lines.push(`${LEGACY_FIELD_LABEL[k]}: ${v}`);
  }
  for (const k of Object.keys(cf).sort()) {
    if (k in LEGACY_FIELD_LABEL || k === 'wants_to_meet') continue;
    const v = str(cf[k]);
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

/** つながりのメモ。新しい列（profile_notes）を優先し、null の時だけ旧項目から畳む。 */
export function customerMemo(c: { profile_notes?: string | null; needs?: string | null; custom_fields?: unknown }): string {
  // 空文字はユーザーが消した状態として尊重する（null の時だけ旧項目に戻る）
  if (c.profile_notes != null) return c.profile_notes.trim();
  return legacyCustomerMemo(c);
}

/** 旧 ai_summary（points/needs/next_actions）を、その回の要約文に畳む（0035 の埋め戻しと同じ書式）。 */
export function legacySummaryText(s: { points?: unknown; needs?: unknown; next_actions?: unknown } | null | undefined): string {
  if (!s) return '';
  const lines = [...list(s.points)];
  const needs = list(s.needs);
  if (needs.length) lines.push(`ニーズ: ${needs.join(' / ')}`);
  const next = list(s.next_actions);
  if (next.length) lines.push(`次アクション: ${next.join(' / ')}`);
  return lines.join('\n');
}

/** 対応履歴の要約文。新しい列（summary）を優先し、無ければ旧 ai_summary から畳む。 */
export function interactionSummaryText(ix: { summary?: string | null; ai_summary?: unknown }): string {
  if (ix.summary != null) return ix.summary.trim();
  const ai = ix.ai_summary && typeof ix.ai_summary === 'object' ? (ix.ai_summary as Record<string, unknown>) : null;
  return legacySummaryText(ai);
}

/** 自分についてのメモ。新しい列（profile_text）を優先し、無ければ旧 user_profile.notes を1行ずつ。 */
export function selfMemo(p: { profile_text?: string | null; user_profile?: unknown }): string {
  if (p.profile_text != null) return p.profile_text.trim();
  const up = p.user_profile && typeof p.user_profile === 'object' ? (p.user_profile as Record<string, unknown>) : {};
  return list(up.notes).join('\n');
}

/**
 * 抽出・確認カードの人物1人分のメモ。新しい形（memo）を優先し、旧形（points/needs/next_actions/custom_fields）
 * で保存されていた途中のセッション・会議録音の候補も同じ書式の文章にして読む。
 */
export function personMemo(p: {
  memo?: string | null;
  points?: unknown;
  needs?: unknown;
  next_actions?: unknown;
  custom_fields?: unknown;
}): string {
  const m = (p.memo ?? '').trim();
  if (m) return m;
  return [legacySummaryText(p), legacyCustomerMemo({ custom_fields: p.custom_fields })].filter(Boolean).join('\n');
}

/** 人物1人分の「つながりたい人」。新しい形（wants_to_meet）を優先し、無ければ旧 custom_fields.wants_to_meet。 */
export function personWantsToMeet(p: { wants_to_meet?: unknown; custom_fields?: unknown }): string[] {
  const direct = list(p.wants_to_meet);
  if (direct.length || Array.isArray(p.wants_to_meet)) return direct;
  const cf = p.custom_fields && typeof p.custom_fields === 'object' ? (p.custom_fields as Record<string, unknown>) : {};
  return list(cf.wants_to_meet);
}
