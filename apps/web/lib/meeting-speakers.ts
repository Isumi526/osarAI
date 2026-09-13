// 会議録音の話者ラベル処理（T4）。ingest/commit のルートから純関数として切り出し、
// e2e（純関数テスト）で決定的に検証できるようにした（T7）。振る舞いは従来と同一。

export interface Speaker {
  label: string;
  isSelf: boolean;
}

/** 行頭の話者ラベル（自分 / 相手1 / 話者A …）。 */
const LABEL_LINE_RE = /^\s*(自分|相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：]/;

/** 「相手1」「話者B」など、名前ではなくラベルそのものか（人物名として保存させない）。 */
export function isSpeakerLabel(name: string): boolean {
  return /^(自分|相手\s*[0-9０-９]*|話者\s*[A-Za-z0-9０-９]*)$/u.test(name.trim());
}

/** 文字起こしの行頭ラベルから話者ロスターを作る。「自分」は isSelf=true。 */
export function parseSpeakers(transcript: string): Speaker[] {
  const seen = new Map<string, boolean>();
  for (const line of transcript.split('\n')) {
    const m = LABEL_LINE_RE.exec(line);
    if (!m) continue;
    const label = m[1]!.replace(/\s+/g, '');
    seen.set(label, label === '自分');
  }
  return [...seen.entries()].map(([label, isSelf]) => ({ label, isSelf }));
}

/** 行頭の話者ラベル「自分:」「相手1:」等を割当実名に置換する。空名はスキップ。本文中の同語は触らない。 */
export function relabelSpeakers(text: string, map: Record<string, string>): string {
  let out = text;
  for (const [label, name] of Object.entries(map)) {
    const nm = (name ?? '').trim();
    if (!nm || !label.trim()) continue;
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // コロン直後の空白も一緒に飲み込み、置換後に二重スペースが残らないようにする。
    out = out.replace(new RegExp(`(^|\\n)\\s*${esc}\\s*[:：][ 　]*`, 'g'), `$1${nm}: `);
  }
  return out;
}
