// JST(UTC+9)基準の日時境界計算（A5対策）。
// サーバー(Vercel)はUTCで動くため `new Date().setHours(0,0,0,0)` は
// UTC深夜0時になり、JSTの月初とは最大9時間ずれる。月次カウント等の
// 「JSTでの月初」が必要な箇所はこのユーティリティで揃える。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 指定時刻(既定=現在)を含む「JSTでの月」の月初0:00(JST)を、実時刻(UTC基準のDate)として返す。 */
export function jstMonthStartUtc(now: Date = new Date()): Date {
  const jstShifted = new Date(now.getTime() + JST_OFFSET_MS);
  const monthStartJstShifted = Date.UTC(jstShifted.getUTCFullYear(), jstShifted.getUTCMonth(), 1, 0, 0, 0, 0);
  return new Date(monthStartJstShifted - JST_OFFSET_MS);
}
