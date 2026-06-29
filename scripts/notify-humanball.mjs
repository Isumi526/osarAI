// ============================================================
//  scripts/notify-humanball.mjs  【正本（~/cc-pipeline）】
//  人ボール（要回答/要対応/ship承認）が発生したとき、本人に LINE 通知を送る。
//  - これは「本人への個人通知」であり、外部一斉送信ではない（許可）。
//  - best-effort：失敗しても自走は止めない（必ず exit 0）。
//  - HUMANBALL_WEBHOOK_URL が未設定なら何もせず終了。
//
//  ※複数プロジェクトが同一 LINE チャンネルに来るため、task 名の頭に .env の NOTIFY_PREFIX（例 [Garage]）を付ける。
//  ※認証は GAS Webhook の仕様に合わせ、secret を JSON ボディに入れる（HMAC ヘッダではない）。
//    GAS は HTTP 200 でも本文 {"ok":false,"error":"unauthorized"} を返すことがあるので、
//    本文の ok も見て成否を判定する（HTTP ステータスだけでは誤判定する）。
//
//  使い方:
//    node scripts/notify-humanball.mjs \
//      --kind 要回答 --task "<タスク名>" --detail "<質問+案や理由>" [--url "<セッションurl>"]
//  必要env(.env): HUMANBALL_WEBHOOK_URL, HUMANBALL_WEBHOOK_SECRET
//  プロジェクト固有値(.env): NOTIFY_PREFIX（接頭辞・例 [Garage]）, NOTIFY_PROJECT（GASラベル）
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* ignore */
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const env = loadEnv(resolve(ROOT, '.env'));
const URL = process.env.HUMANBALL_WEBHOOK_URL || env.HUMANBALL_WEBHOOK_URL;
const SECRET = process.env.HUMANBALL_WEBHOOK_SECRET || env.HUMANBALL_WEBHOOK_SECRET;
// プロジェクト固有値は .env から（正本にハードコードしない）。
//   NOTIFY_PREFIX  … task 名頭に付ける接頭辞（例 [Garage] / [sido] / [osarAI]）。未設定なら接頭辞なし。
//   NOTIFY_PROJECT … GAS 側のプロジェクト名ラベル（未設定なら "project"）。
const NOTIFY_PREFIX = (process.env.NOTIFY_PREFIX || env.NOTIFY_PREFIX || '').trim();
const NOTIFY_PROJECT = (process.env.NOTIFY_PROJECT || env.NOTIFY_PROJECT || 'project').trim();

if (!URL) {
  console.warn('HUMANBALL_WEBHOOK_URL 未設定のため通知スキップ（best-effort）');
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const rawTask = typeof args.task === 'string' ? args.task : '(無題)';
const task = NOTIFY_PREFIX && !rawTask.startsWith(NOTIFY_PREFIX) ? `${NOTIFY_PREFIX} ${rawTask}` : rawTask;
// --url 未指定なら Claude Code Remote Control の固定入口を既定にする（個別セッションURLは毎回変わり取得できないため）。
const url = typeof args.url === 'string' ? args.url : 'https://claude.ai/code';
// 認証は secret を JSON ボディに入れる（GAS Webhook と同じ契約）。HMAC ヘッダではない。
// project は GAS 側のプロジェクト名ラベル出し分け用（.env の NOTIFY_PROJECT）。
const payload = {
  project: NOTIFY_PROJECT,
  secret: SECRET || '',
  kind: typeof args.kind === 'string' ? args.kind : '通知',
  task,
  detail: typeof args.detail === 'string' ? args.detail : '',
  url,
};

try {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let ok = res.ok;
  try {
    const j = JSON.parse(text);
    if (j && typeof j.ok === 'boolean') ok = j.ok; // GAS 本文の ok を優先（200でも ok:false がある）
  } catch {
    /* 非JSON応答は HTTP ステータスで判断 */
  }
  if (ok) {
    console.log(`✓ humanball通知を送信 (${payload.kind}: ${task})`);
  } else {
    console.error(
      `! humanball通知に失敗 (HTTP ${res.status}): ${text.slice(0, 200)}。自走は継続します。`,
    );
  }
} catch (e) {
  console.error(`! humanball通知に失敗 (${e?.message || e})。自走は継続します。`);
}

// 通知は best-effort。何があっても自走を止めない。
process.exit(0);
