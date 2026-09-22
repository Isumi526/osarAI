// 会議録音の話者ラベル処理（T4）。ingest/commit のルートから純関数として切り出し、
// e2e（純関数テスト）で決定的に検証できるようにした（T7）。振る舞いは従来と同一。

export interface Speaker {
  label: string;
  isSelf: boolean;
}

/** 行頭の話者ラベル（自分 / 相手1 / 話者A …）＝Gemini の文字起こしが付ける既知ラベル。 */
const LABEL_LINE_RE = /^\s*(自分|相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：]/;
/**
 * 任意の話者名ラベル（取り込んだ文字起こし用・例「山田 太郎:」「Speaker 1:」）。
 * 普通の文に含まれるコロン（「時間: 14時」）を話者と誤認しないよう、20文字以内・
 * かつ transcript 内で2行以上に現れるものだけを話者とみなす。
 */
const GENERIC_LABEL_RE = /^\s*([^\s:：]{1,20}(?:[ \u3000][^\s:：]{1,20})?)\s*[:：]/;

/** 「相手1」「話者B」など、名前ではなくラベルそのものか（人物名として保存させない）。 */
export function isSpeakerLabel(name: string): boolean {
  return /^(自分|相手\s*[0-9０-９]*|話者\s*[A-Za-z0-9０-９]*)$/u.test(name.trim());
}

/** 文字起こしの行頭ラベルから話者ロスターを作る。「自分」は isSelf=true。 */
export function parseSpeakers(transcript: string): Speaker[] {
  const known = new Map<string, boolean>();
  const generic = new Map<string, number>();
  for (const line of transcript.split('\n')) {
    const m = LABEL_LINE_RE.exec(line);
    if (m) {
      const label = m[1]!.replace(/\s+/g, '');
      known.set(label, label === '自分');
      continue;
    }
    const g = GENERIC_LABEL_RE.exec(line);
    if (g) {
      const label = g[1]!.trim();
      generic.set(label, (generic.get(label) ?? 0) + 1);
    }
  }
  const out: Speaker[] = [...known.entries()].map(([label, isSelf]) => ({ label, isSelf }));
  for (const [label, count] of generic) {
    if (count >= 2 && out.length < 10 && !out.some((s) => s.label === label)) out.push({ label, isSelf: false });
  }
  return out;
}

/**
 * 他ツールの文字起こしを「話者: 発言」の1行形式に寄せる（T7b・Notta / Zoom 等の貼り付け用）。
 * - 「話者名  00:01:23」（名前＋タイムスタンプの行）の次の行が発言 → 「話者名: 発言」
 * - 「[00:01:23] 名前: 発言」「00:01 名前: 発言」→ 先頭のタイムスタンプを落とす
 * - 既に「名前: 発言」ならそのまま。それ以外の行もそのまま残す
 */
export function normalizeImportedTranscript(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let pendingSpeaker: string | null = null;
  const TS = '(?:\\[?\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?\\]?)';
  const headerRe = new RegExp(`^\\s*(.{1,30}?)\\s*[ \\u3000]${TS}\\s*$`);
  // Notta の TXT 書き出し（話者を含める・経過時間なし）は「remote:0」「local:1」「話者 1」だけの行の次に発言が来る。
  // local=録音した本人側（自分）/ remote=相手側（Zoom 連携時）。
  const bareLabelRe = /^\s*((?:local|remote|speaker|話者|相手)\s*[:：]?\s*(\d+))\s*$/iu;
  const leadTsRe = new RegExp(`^\\s*${TS}\\s*[-–—]?\\s*`);
  const toLabel = (name: string): string => {
    const m = /^(local|remote|speaker|話者|相手)\s*[:：]?\s*(\d+)$/iu.exec(name.trim());
    if (!m) return name.trim().replace(/^(話者|相手)\s+/u, '$1');
    const kind = m[1]!.toLowerCase();
    const n = Number(m[2]);
    if (kind === 'local') return '自分';
    if (kind === 'remote') return `相手${n + 1}`;
    return `${m[1]}${m[2]}`;
  };
  for (const raw of lines) {
    const line = raw.replace(leadTsRe, '');
    if (!line.trim()) continue;
    const h = headerRe.exec(line);
    if (h && !/[:：]/.test(h[1]!)) {
      // 「話者 1」「相手 2」は Gemini 由来の既知ラベルと同じ形（空白なし）に揃える
      pendingSpeaker = toLabel(h[1]!);
      continue;
    }
    const b = bareLabelRe.exec(line);
    if (b) {
      pendingSpeaker = toLabel(b[1]!);
      continue;
    }
    if (pendingSpeaker) {
      out.push(`${pendingSpeaker}: ${line.trim()}`);
      pendingSpeaker = null;
      continue;
    }
    out.push(line.trim());
  }
  return out.join('\n');
}

/**
 * 行頭の話者ラベル「自分:」「相手1:」等を割当実名に置換する。空名はスキップ。
 * 既定では本文中の同語は触らない（文字起こしは発言そのままを残したいため）。
 * `inline: true` を渡すと本文中の「相手N」も実名化する（議事録用。Gemini が
 * 「村田涼太氏（相手1）」のようにラベルを書き残すことがあるので、括弧書きは消す）。
 * 「自分」は inline でも置換しない＝誰の発言か分かる方が親切。
 */
export function relabelSpeakers(text: string, map: Record<string, string>, opts: { inline?: boolean } = {}): string {
  let out = text;
  for (const [label, name] of Object.entries(map)) {
    const nm = (name ?? '').trim();
    if (!nm || !label.trim()) continue;
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // コロン直後の空白も一緒に飲み込み、置換後に二重スペースが残らないようにする。
    out = out.replace(new RegExp(`(^|\\n)\\s*${esc}\\s*[:：][ 　]*`, 'g'), `$1${nm}: `);
    if (opts.inline && /^相手\s*\d*$/u.test(label.trim())) {
      // 「相手1」が「相手10」の一部を壊さないよう、後ろに数字が続く場合は除外する。
      out = out.replace(new RegExp(`[（(]\\s*${esc}(?![0-9０-９])\\s*[）)]`, 'g'), '');
      out = out.replace(new RegExp(`${esc}(?![0-9０-９])`, 'g'), nm);
    }
  }
  return out;
}

/**
 * 録音者本人がほぼ無音だった時に、紛れ込んだ「自分:」行を相手の発言に寄せる（T7c）。
 * マイクゲートの取りこぼし（スピーカーの回り込みが一瞬だけ通る）で1行だけ「自分:」に
 * なることがあり、議事録で「自分が話した」と読めてしまうため、プロンプトの指示だけに
 * 頼らず決定的に潰す。直前の話者が分かればその人に、分からなければ fallback に寄せる。
 */
export function dropSelfLabels(transcript: string, fallback = '相手1'): string {
  const lines = transcript.split('\n');
  let last = fallback;
  return lines
    .map((line) => {
      const m = /^\s*(自分|相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：][ 　]*/.exec(line);
      if (!m) return line;
      const label = m[1]!.replace(/\s+/g, '');
      if (label !== '自分') {
        last = label;
        return line;
      }
      return `${last}: ${line.slice(m[0].length)}`;
    })
    .join('\n');
}

/** [MM:SS] 付きの1行。単一トラックの文字起こしを時刻順に合成するために使う。 */
export interface TimedLine {
  sec: number;
  label: string;
  text: string;
}

const TIMED_LINE_RE = /^\s*[[［(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\]］)]?\s*(.*)$/;

/**
 * 「[MM:SS] 発話」形式の文字起こしを行に分解する（2026-09-22・2トラック録音）。
 * 行内に「相手1:」等のラベルがあればそれを、無ければ defaultLabel を話者にする。
 * 時刻が取れない行は直前の時刻に続くものとして扱い、落とさない。
 */
export function parseTimedTranscript(text: string, defaultLabel: string): TimedLine[] {
  const out: TimedLine[] = [];
  let last = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = TIMED_LINE_RE.exec(line);
    let sec = last;
    let body = line;
    if (m) {
      // [H:MM:SS] と [MM:SS] の両方を受ける
      sec = m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
      body = (m[4] ?? '').trim();
      last = sec;
    }
    if (!body) continue;
    let label = defaultLabel;
    const lm = /^(相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：]\s*/.exec(body);
    if (lm) {
      label = lm[1]!.replace(/\s+/g, '');
      body = body.slice(lm[0].length).trim();
    }
    if (body) out.push({ sec, label, text: body });
  }
  return out;
}

/**
 * 相手トラックと自分トラックの行を時刻順に1本の文字起こしへ合成する。
 * 同時刻なら相手を先に置く（相手の問いかけ→自分の応答、が会話として自然なため）。
 * 発話は1行1発話のまま残す（まとめると長い独白になって読みにくく、時刻の情報も失う）。
 */
export function mergeTimedTranscripts(other: TimedLine[], self: TimedLine[]): string {
  return [
    ...other.map((l, i) => ({ ...l, order: 0, i })),
    ...self.map((l, i) => ({ ...l, order: 1, i })),
  ]
    .sort((a, b) => a.sec - b.sec || a.order - b.order || a.i - b.i)
    .map((l) => `${l.label}: ${l.text}`)
    .join('\n');
}
