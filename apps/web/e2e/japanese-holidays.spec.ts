import { test, expect } from '@playwright/test';
import { isJapaneseHoliday, HOLIDAY_CALC_YEAR_RANGE } from '../../mobile/src/lib/holidays';

// 日程調整の候補から祝日を除くロジック（apps/mobile/src/lib/holidays.ts）の回帰。
// findFreeSlots() が既定で祝日を候補から外すため、ここが間違うと
// 「相手に送る日程候補に祝日が混ざる / 平日が消える」という表に出る事故になる。
// 運用者が懸念したのは算出方式の境界条件（春分秋分・ハッピーマンデー・振替休日・
// 国民の休日）なので、そこを実際の暦と突き合わせて固定する。

const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d);

function holidaysOf(year: number): string[] {
  const out: string[] = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const dt = iso(year, m, d);
      if (dt.getMonth() !== m - 1) continue;
      if (isJapaneseHoliday(dt)) out.push(`${m}/${d}`);
    }
  }
  return out;
}

test.describe('isJapaneseHoliday: 実際の暦との一致', () => {
  test('2026年の祝日18日が実際の暦と一致する', () => {
    expect(holidaysOf(2026)).toEqual([
      '1/1',   // 元日
      '1/12',  // 成人の日（第2月）
      '2/11',  // 建国記念の日
      '2/23',  // 天皇誕生日
      '3/20',  // 春分の日
      '4/29',  // 昭和の日
      '5/3',   // 憲法記念日（日）
      '5/4',   // みどりの日
      '5/5',   // こどもの日
      '5/6',   // 振替休日（5/3が日曜）
      '7/20',  // 海の日（第3月）
      '8/11',  // 山の日
      '9/21',  // 敬老の日（第3月）
      '9/22',  // 国民の休日（敬老の日と秋分の日に挟まれる）
      '9/23',  // 秋分の日
      '10/12', // スポーツの日（第2月）
      '11/3',  // 文化の日
      '11/23', // 勤労感謝の日
    ]);
  });

  test('2027年の祝日17日が実際の暦と一致する（春分が日曜→振替あり・国民の休日は無し）', () => {
    expect(holidaysOf(2027)).toEqual([
      '1/1', '1/11', '2/11', '2/23',
      '3/21', // 春分の日（日）
      '3/22', // 振替休日
      '4/29', '5/3', '5/4', '5/5',
      '7/19', '8/11',
      '9/20', // 敬老の日
      '9/23', // 秋分の日（間が2日空くので国民の休日は成立しない）
      '10/11', '11/3', '11/23',
    ]);
  });
});

test.describe('境界条件（運用者が懸念した箇所）', () => {
  test('平日は祝日ではない', () => {
    expect(isJapaneseHoliday(iso(2026, 6, 10))).toBe(false);
  });

  test('振替休日: 祝日が日曜なら翌平日が休みになる', () => {
    expect(isJapaneseHoliday(iso(2026, 5, 6))).toBe(true);
  });

  test('国民の休日: 祝日に挟まれた平日は休みになる（2026年のシルバーウィーク）', () => {
    expect(isJapaneseHoliday(iso(2026, 9, 22))).toBe(true);
  });

  test('ハッピーマンデーは曜日で動く（成人の日は必ず月曜）', () => {
    for (const y of [2026, 2027, 2028]) {
      const jan = holidaysOf(y).filter((s) => s.startsWith('1/') && s !== '1/1');
      expect(jan).toHaveLength(1);
      const day = Number(jan[0]!.split('/')[1]);
      expect(new Date(y, 0, day).getDay()).toBe(1);
    }
  });
});

test.describe('第22条: 対応年の外で黙って「祝日なし」にしない', () => {
  test('対応年の範囲が公開されている', () => {
    expect(HOLIDAY_CALC_YEAR_RANGE.from).toBe(1980);
    expect(HOLIDAY_CALC_YEAR_RANGE.to).toBe(2099);
  });

  test('範囲内の年は対応と判定される', () => {
    expect(HOLIDAY_CALC_YEAR_RANGE.supports(2026)).toBe(true);
    expect(HOLIDAY_CALC_YEAR_RANGE.supports(2099)).toBe(true);
  });

  test('範囲外の年は「対応していない」と分かる（黙って false を返す実装にしない）', () => {
    expect(HOLIDAY_CALC_YEAR_RANGE.supports(2100)).toBe(false);
    expect(HOLIDAY_CALC_YEAR_RANGE.supports(1979)).toBe(false);
  });
});
