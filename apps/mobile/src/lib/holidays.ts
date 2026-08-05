// 日本の祝日判定（2026-08-06 追加・日程調整の候補から祝日を除くために使う）。
// 外部APIに依存すると通信失敗時に候補が出せなくなるため、内閣府の規則をそのまま計算する。
// 対応: 固定日の祝日 / ハッピーマンデー / 春分・秋分（近似式） / 振替休日 / 国民の休日。

/** 春分日（1980-2099の近似式。日本の官報決定と一致する範囲で使う） */
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
/** 秋分日（同上） */
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その月のn回目の月曜日（ハッピーマンデー用） */
function nthMonday(year: number, month1: number, nth: number): number {
  const first = new Date(year, month1 - 1, 1).getDay(); // 0=日
  const firstMonday = 1 + ((8 - first) % 7);
  return firstMonday + (nth - 1) * 7;
}

/** その年の祝日（振替休日・国民の休日を含む）を 'YYYY-MM-DD' の集合で返す */
function holidaysOfYear(year: number): Set<string> {
  const key = (m: number, d: number) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const base = new Set<string>([
    key(1, 1), // 元日
    key(1, nthMonday(year, 1, 2)), // 成人の日
    key(2, 11), // 建国記念の日
    key(2, 23), // 天皇誕生日
    key(3, vernalEquinoxDay(year)), // 春分の日
    key(4, 29), // 昭和の日
    key(5, 3), // 憲法記念日
    key(5, 4), // みどりの日
    key(5, 5), // こどもの日
    key(7, nthMonday(year, 7, 3)), // 海の日
    key(8, 11), // 山の日
    key(9, nthMonday(year, 9, 3)), // 敬老の日
    key(9, autumnalEquinoxDay(year)), // 秋分の日
    key(10, nthMonday(year, 10, 2)), // スポーツの日
    key(11, 3), // 文化の日
    key(11, 23), // 勤労感謝の日
  ]);

  const result = new Set(base);
  // 振替休日: 祝日が日曜なら、その後の最初の平日を休日にする
  for (const iso of base) {
    const d = new Date(`${iso}T00:00:00`);
    if (d.getDay() !== 0) continue;
    const sub = new Date(d);
    do {
      sub.setDate(sub.getDate() + 1);
    } while (result.has(toIso(sub)));
    result.add(toIso(sub));
  }
  // 国民の休日: 祝日に挟まれた平日（敬老の日と秋分の日の間など）
  const sorted = [...result].sort();
  for (const iso of sorted) {
    const d = new Date(`${iso}T00:00:00`);
    const next = new Date(d);
    next.setDate(next.getDate() + 2);
    if (!result.has(toIso(next))) continue;
    const between = new Date(d);
    between.setDate(between.getDate() + 1);
    if (between.getDay() !== 0 && !result.has(toIso(between))) result.add(toIso(between));
  }
  return result;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const cache = new Map<number, Set<string>>();

/** 日本の祝日（振替休日・国民の休日を含む）かどうか */
export function isJapaneseHoliday(date: Date): boolean {
  const year = date.getFullYear();
  if (!cache.has(year)) cache.set(year, holidaysOfYear(year));
  return cache.get(year)!.has(toIso(date));
}
