import { test, expect } from '@playwright/test';
import { jstMonthStartUtc } from '@osarai/shared';

// Stripe課金負債台帳 A5 の恒久回帰: AI相談の月次上限カウントがサーバーの
// ローカル時刻(Vercel=UTC)の月初を基準にしており、JSTとの9時間ズレで
// 月初/月末付近のカウント境界が狂っていた問題。
// advice/route.ts はこの jstMonthStartUtc() を月初判定に使う(A5対策)。

test.describe('A5: JST基準の月初計算', () => {
  test('UTCでは前月扱いになる時刻がJSTでは当月の月初として扱われる', () => {
    // 2026-07-01T00:30:00+09:00 = 2026-06-30T15:30:00Z。
    // UTC基準のロジック(旧実装)ではこの時刻はまだ6月扱いになってしまうが、
    // JSTでは7/1の月初を過ぎているため「7月分」としてカウントされるべき。
    const jstJustAfterMonthStart = new Date('2026-06-30T15:30:00.000Z');
    const monthStart = jstMonthStartUtc(jstJustAfterMonthStart);
    // JST 7/1 0:00 = UTC 6/30 15:00
    expect(monthStart.toISOString()).toBe('2026-06-30T15:00:00.000Z');
    expect(monthStart.getTime()).toBeLessThanOrEqual(jstJustAfterMonthStart.getTime());
  });

  test('JSTでの月末最後の瞬間はまだ当月の月初以降として扱われる', () => {
    // 2026-06-30T23:59:59+09:00 = 2026-06-30T14:59:59Z（JSTでまだ6月内）
    const jstJustBeforeMonthEnd = new Date('2026-06-30T14:59:59.000Z');
    const monthStart = jstMonthStartUtc(jstJustBeforeMonthEnd);
    // JST 6/1 0:00 = UTC 5/31 15:00
    expect(monthStart.toISOString()).toBe('2026-05-31T15:00:00.000Z');
  });

  test('UTC日付とJST日付が一致する日中の時刻でも常にJST基準で計算される', () => {
    const midday = new Date('2026-07-15T03:00:00.000Z'); // JST 12:00
    const monthStart = jstMonthStartUtc(midday);
    expect(monthStart.toISOString()).toBe('2026-06-30T15:00:00.000Z'); // JST 7/1 0:00
  });
});
