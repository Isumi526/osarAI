// ============================================================
//  scripts/log-friction.mjs — 摩擦を Notion 摩擦ログDB へ自動記録（全コマンド共通hook）
//  設計: plans/20260724-phase5-plan.md。
//
//  第19条: 摩擦の正本は Notion 摩擦ログDB。各コマンドはここへ書くだけ。
//  第24条: 全コマンド面に Notion 書込権限を付与する＝30日再監査対象（BUILD-STATE 積みタスク）。
//  第6条: 記録失敗は「異常」として通知する（silent fail で Loop F 入力が無音欠落するのを防ぐ）。
//  Denylist(T18#2): NOTION_TOKEN は env/keychain から。スクリプト/リポに直書きしない。
//
//  使い方:
//    node scripts/log-friction.mjs --type "計画と報告の乖離" --content "..." --command "/run" [--commit <sha>]
//    NOTION_TOKEN 未設定時: MCP 経由で入れるための payload を出力して exit 0（本番は env 経由で直接 POST）。
// ============================================================
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notionToken } from './notion-token.mjs';   // env → keychain（/ball の導線が動くように・2026-07-30）

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRICTION_DS = '5cf53ea8-75df-41c2-8818-6ab47613fde4'; // 摩擦ログ **data source** id（MCP 経路で使う）
// 摩擦ログ **database** id（REST 経路で使う）。
//   ⚠ 2026-07-29 まで REST の `parent.database_id` に上の data source id を渡しており、
//     **Notion が 404 を返して1件も記録できていなかった**（既存12件はすべて MCP 経路で投入されたもの）。
//     data source と database は別 ID 体系であり、`Notion-Version: 2022-06-28` の
//     `parent` は **database_id** を要求する。実データで確認して確定:
//     collection://5cf53ea8… の url は https://app.notion.com/p/8377e77e4bfa4e9dbc49f67bf4213203
const FRICTION_DB = '8377e77e-4bfa-4e9d-bc49-f67bf4213203';
// MASTER-PROMPT Loop F 対応表 8型＋創発2型＋catch-all（review-constitution 🔴1で一本化）
const TYPES = ['判断待ちが発生', '見た目', '類似箇所が残った', '止まった・英語化', '手戻り', '正本と実装の乖離', '計画と報告の乖離', '憲法定義の矛盾', '第19条フォーク', 'セッション中断', 'その他'];

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const rawType = val('--type') || 'その他';
const type = TYPES.includes(rawType) ? rawType : 'その他';
const content = val('--content') || '(内容未指定)';
const command = val('--command') || '(不明)';
const commit = val('--commit') || '';

const payload = {
  data_source_id: FRICTION_DS,
  properties: { 内容: content, 型: type, 発生回数: 1, 修正先: `発生元コマンド: ${command}`, ステータス: '記録', 関連コミット: commit },
};

function notifyFailure(reason) {
  // 第6条: 記録失敗は異常として通知（best-effort）
  spawnSync('node', [join(ROOT, 'scripts', 'notify-humanball.mjs'), '--kind', '要対応',
    '--task', 'log-friction: 摩擦記録に失敗', '--detail', `${reason} / 型=${type} / cmd=${command}`], { stdio: 'inherit' });
}

const TOKEN = notionToken();
if (!TOKEN) {
  // token 未設定: MCP 経由で投入するための payload を出力（本番は env 経由）。silent 成功にしない。
  console.log(JSON.stringify({ status: 'no-token', note: 'NOTION_TOKEN 未設定。下記 payload を MCP notion-create-pages で投入（本番は env 直POST）', payload }));
  process.exit(0);
}

try {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: FRICTION_DB },
      properties: {
        内容: { title: [{ text: { content } }] },
        型: { multi_select: [{ name: type }] },
        発生回数: { number: 1 },
        修正先: { rich_text: [{ text: { content: `発生元コマンド: ${command}` } }] },
        ステータス: { select: { name: '記録' } },
        関連コミット: { rich_text: [{ text: { content: commit } }] },
      },
    }),
  });
  if (!res.ok) { notifyFailure(`HTTP ${res.status}`); console.error(`log-friction 失敗: HTTP ${res.status}`); process.exit(1); }
  console.log(JSON.stringify({ status: 'logged', type, command }));
} catch (e) {
  notifyFailure(e?.message || String(e));
  console.error(`log-friction 失敗: ${e?.message || e}`);
  process.exit(1);
}
