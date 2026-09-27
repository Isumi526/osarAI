import { test, expect } from '@playwright/test';
import { mergeExtracted, toProposals } from '../lib/proposal-extraction';

// 相手待ちタスク（2026-09-27）: 会議で相手が引き受けたことも assignee="other" で残す。
// 自分の用件と相手の用件は、題名が似ていても別物として扱う（重複排除で片方が消えない）。

const now = new Date('2026-08-28T03:00:00Z');

test('toProposals: assignee を引き継ぎ、未指定は self にする', () => {
  const p = toProposals(
    {
      people: [{ name: '山田', points: [], needs: [], next_actions: [] }],
      schedules: [],
      tasks: [
        { title: '応募書類を更新する', due_date: '2026-08-30', assignee: 'self' },
        { title: '求人を数社提案する', due_date: '2026-08-29', assignee: 'other' },
        { title: 'LINEで志望度を連絡する' },
      ],
      self_notes: [],
    },
    [],
    now,
  );
  expect(p.tasks.map((t) => [t.title, t.assignee])).toEqual([
    ['応募書類を更新する', 'self'],
    ['求人を数社提案する', 'other'],
    ['LINEで志望度を連絡する', 'self'],
  ]);
  // 期限は JST のその日の終わり
  expect(p.tasks[0]!.due_at).toBe('2026-08-30T14:59:00.000Z');
});

test('toProposals: 同じ題名でも自分と相手の用件は両方残す', () => {
  const p = toProposals(
    {
      people: [],
      schedules: [],
      tasks: [
        { title: '資料を送る', assignee: 'self' },
        { title: '資料を送る', assignee: 'other' },
      ],
      self_notes: [],
    },
    [],
    now,
  );
  expect(p.tasks.map((t) => t.assignee).sort()).toEqual(['other', 'self']);
});

test('mergeExtracted: ターンをまたいでも assignee を保ち、自分と相手を混ぜない', () => {
  const merged = mergeExtracted(
    { people: [], schedules: [], tasks: [{ title: '見積もりを送る', assignee: 'other' }], self_notes: [] },
    { people: [], schedules: [], tasks: [{ title: '見積もりを送る', assignee: 'self' }], self_notes: [] },
  );
  expect((merged.tasks ?? []).map((t) => t.assignee).sort()).toEqual(['other', 'self']);
});
