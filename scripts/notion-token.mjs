// ============================================================
//  scripts/notion-token.mjs — NOTION_TOKEN の取得（env → keychain）
//
//  なぜ要るか（2026-07-30）:
//   `/ball` は人間に「node scripts/decide.mjs を叩け」と案内するが、
//   トークンは keychain にあり shell の環境変数には無いため、**案内どおり叩くと no-token で落ちた**
//   （実際に運用者が3件の受理判断で踏んだ）。器が「動かないコマンド」を案内していた＝第22条の趣旨に反する。
//   launchd 経路（loop-a-run.sh:22）は keychain から取っているので、**同じ在処を人間の経路にも通す**。
//
//  keychain のサービス名はここが唯一の在処（第19条: 複数正本を作らない）。
//   登録: security add-generic-password -a "$USER" -s cc-pipeline-notion-token -w '<TOKEN>'
// ============================================================
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'cc-pipeline-notion-token';

// env を優先し、無ければ keychain を引く。**取れなければ null**（呼び出し側が fail-closed する）
export function notionToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const t = execFileSync('security', ['find-generic-password', '-a', process.env.USER || '', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return t || null;
  } catch { return null; }   // keychain 未登録・非 macOS・ロック中
}
