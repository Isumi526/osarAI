// ============================================================
//  scripts/priority-rank.mjs — 「優先順位」順位の唯一の正本（副作用ゼロ）
//
//  なぜ要るか（2026-08-21・plans/20260821-ball-cockpit.md §何をするか-2）:
//   `優先順位`(緊急>高>中>低) の順位マップは next-target.mjs:72 に local const で埋まっていて
//   export されておらず、同ファイルは main-guard 無し＋トップレベル `await fetch`／`process.exit` を
//   持つ。だから next-target を直 import すると**モジュール本体が走り**、next-ball の NET 不変条件
//   （fetch を呼ぶパスが存在しない）を破る。→ 順位マップだけを**副作用ゼロの共有モジュール**に切り出し、
//   next-target.mjs と next-ball.mjs の両方が import する（真の単一正本・第19条）。
//
//  ★ 副作用ゼロの契約（計画⑧ 完了条件）:
//   このファイルは fetch／process.exit／トップレベル await を**一切持たない**。import しても何も
//   起きない（NOTION_TOKEN 無しでも exit 0・ネットも叩かない）。--selftest だけが CLI として走り、
//   それも main-guard の内側にある（import では発火しない）。
//
//  使い方:
//    node scripts/priority-rank.mjs --selftest
//    import { PRIORITY_RANK, rankOfPriority } from './priority-rank.mjs'
// ============================================================
import { fileURLToPath } from 'node:url';

// 緊急 > 高 > 中 > 低。数字が小さいほど先。
//   ※ 緊急 は現 DEV_BACKLOG_DB の select 選択肢に無く本データ源では空振り（🟡A）だが、
//     正本統一と将来のため最上位を保持する（計画⑧ §2）。
export const PRIORITY_RANK = { '緊急': 0, '高': 1, '中': 2, '低': 3 };

// 空欄/未知は最後(9)。欠損を先頭にも中位にも寄せない（第22条: 呼び出し側で `?? 9` を自前に書かない）。
export function rankOfPriority(p) {
  return PRIORITY_RANK[p] ?? 9;
}

// ---- selftest（main-guard の内側・import では走らない）----
function selftest() {
  const errs = [];
  // 順位マップの値
  if (PRIORITY_RANK['緊急'] !== 0) errs.push('緊急 が最上位(0)でない');
  if (!(PRIORITY_RANK['緊急'] < PRIORITY_RANK['高'] && PRIORITY_RANK['高'] < PRIORITY_RANK['中'] && PRIORITY_RANK['中'] < PRIORITY_RANK['低']))
    errs.push('緊急>高>中>低 の単調性が壊れている');
  // 既知の値
  if (rankOfPriority('高') !== 1) errs.push('rankOfPriority(高) が 1 でない');
  if (rankOfPriority('低') !== 3) errs.push('rankOfPriority(低) が 3 でない');
  // 空欄/未知は最後(9)。中位に寄せない
  if (rankOfPriority(null) !== 9) errs.push('rankOfPriority(null) が 9(最後) でない');
  if (rankOfPriority(undefined) !== 9) errs.push('rankOfPriority(undefined) が 9(最後) でない');
  if (rankOfPriority('') !== 9) errs.push('rankOfPriority("") が 9(最後) でない');
  if (rankOfPriority('空欄') !== 9) errs.push('rankOfPriority("空欄") が 9(最後) でない');
  if (rankOfPriority('謎の値') !== 9) errs.push('未知の値が 9(最後) に落ちない');
  // 空欄が「低」より後（＝欠損を低より下に置く・欠損を先頭に寄せない）
  if (!(rankOfPriority('低') < rankOfPriority(null))) errs.push('空欄が「低」より前に来ている（欠損を先頭寄せしている）');
  // 決定的
  if (rankOfPriority('中') !== rankOfPriority('中')) errs.push('非決定的');
  if (errs.length) { console.error('SELFTEST FAIL:\n- ' + errs.join('\n- ')); process.exit(1); }
  console.log('SELFTEST PASS: 緊急>高>中>低 単調✓ 既知の値✓ 空欄/未知は最後(9)✓ 空欄は低より後(欠損を先頭寄せしない)✓ 決定的✓ 副作用ゼロ(import では何も走らない)✓');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) selftest();
