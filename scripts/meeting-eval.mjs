// ============================================================
//  scripts/meeting-eval.mjs — 会議録音パイプラインの精度評価（T7b・2026-09-21）
//
//  実際の会議音声（Notta 等から書き出した mp3/m4a）または文字起こしテキストを
//  ローカルの web API（/api/meeting/upload-url → Storage → /api/meeting/ingest）に流し、
//  文字起こし・議事録・3データ候補を保存する。参照文字起こし（--ref・Notta の書き出し）が
//  あれば、文字誤り率(CER)・話者交代数・固有名詞の一致率を出す。
//
//  使い方（local Supabase + web 3055 が起動している前提・DB 書き込みはローカルのみ）:
//    node scripts/meeting-eval.mjs --audio ~/Downloads/meeting.mp3 [--ref ~/Downloads/meeting-notta.txt]
//    node scripts/meeting-eval.mjs --text ~/Downloads/meeting-notta.txt
//    共通: [--out eval-out] [--api http://localhost:3055] [--supabase http://127.0.0.1:54321]
//          [--email meeting-local@example.com] [--password testpassword123]
//          [--capture pc_local|mobile_speaker]  ※音声のチャンネル前提（既定 mobile_speaker=モノラル）
//          [--terms 固有名詞,商品名,...]        ※一致率を見たい語（省略時は参照側の漢字/カタカナ語から自動抽出）
//
//  出力: <out>/<timestamp>/{transcript.txt, minutes.txt, proposals.json, report.md}
//  ※ 本番には接続しない（--api / --supabase の既定はローカル）。Gemini は実キーで呼ぶ。
// ============================================================
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : d;
};
const AUDIO = val('--audio');
const TEXT = val('--text');
const REF = val('--ref');
const OUT = val('--out', 'eval-out');
const API = val('--api', 'http://localhost:3055');
const SUPA = val('--supabase', 'http://127.0.0.1:54321');
const EMAIL = val('--email', 'meeting-local@example.com');
const PASSWORD = val('--password', 'testpassword123');
const CAPTURE = val('--capture', 'mobile_speaker');
const TERMS = val('--terms');
const ANON = val('--anon', 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH');

if (!AUDIO && !TEXT) {
  console.error('使い方: node scripts/meeting-eval.mjs --audio <mp3|m4a|webm> [--ref <参照文字起こし.txt>] | --text <文字起こし.txt>');
  process.exit(1);
}
if (/supabase\.co|osarai\.app/.test(API + SUPA)) {
  console.error('✗ 本番らしき接続先です。評価はローカル（3055 / 54321）に対してのみ行ってください。');
  process.exit(1);
}

const MIME = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

async function login() {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`ログイン失敗: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function api(token, path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${j.message ?? j.error ?? ''} ${j.detail ?? ''}`);
  return j;
}

/** 比較用に正規化: 話者ラベル・タイムスタンプ・空白・句読点を落とし、全角半角を揃える */
function normalizeForCer(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*[^\s:：]{1,20}(?:[ 　][^\s:：]{1,20})?\s*[:：]\s*/, '')) // 「名前: 」
    .map((l) => l.replace(/\[?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\]?/g, ''))
    .join('')
    .normalize('NFKC')
    .replace(/[\s、。，．・「」『』（）()!！?？…ー〜~\-–—]/g, '')
    .toLowerCase();
}

/** 文字誤り率。長文でもメモリを抑えるため 2 行 DP。 */
function cer(hyp, ref) {
  const a = [...ref];
  const b = [...hyp];
  if (a.length === 0) return { cer: b.length ? 1 : 0, refLen: 0, dist: b.length };
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[b.length];
  return { cer: dist / a.length, refLen: a.length, dist };
}

/** 参照側から固有名詞っぽい語（漢字2〜6字 / カタカナ3字以上）を抽出（頻度上位） */
function autoTerms(ref) {
  const freq = new Map();
  for (const m of ref.matchAll(/[゠-ヿ]{3,}|[一-鿿]{2,6}/g)) freq.set(m[0], (freq.get(m[0]) ?? 0) + 1);
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 40)
    .map(([t]) => t);
}

function speakerTurns(text) {
  return text.split('\n').filter((l) => /^\s*[^\s:：]{1,20}(?:[ 　][^\s:：]{1,20})?\s*[:：]/.test(l)).length;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(OUT, stamp);
  mkdirSync(outDir, { recursive: true });
  const token = await login();
  const t0 = Date.now();
  let res;
  if (AUDIO) {
    const file = resolve(AUDIO);
    const ext = extname(file).toLowerCase();
    const mime = MIME[ext];
    if (!mime) throw new Error(`未対応の拡張子: ${ext}`);
    const bytes = readFileSync(file);
    console.log(`▶ 音声: ${basename(file)} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB, ${mime})`);
    const { path, token: upToken } = await api(token, '/api/meeting/upload-url', { mimeType: mime });
    const up = await fetch(`${SUPA}/storage/v1/object/upload/sign/recordings/${path}?token=${encodeURIComponent(upToken)}`, {
      method: 'PUT',
      headers: { apikey: ANON, 'content-type': mime },
      body: bytes,
    });
    if (!up.ok) throw new Error(`アップロード失敗 ${up.status}: ${await up.text()}`);
    console.log(`  アップロード完了 (${((Date.now() - t0) / 1000).toFixed(1)}s) → ingest 中…（長尺は数分）`);
    const t1 = Date.now();
    res = await api(token, '/api/meeting/ingest', { recordingPath: path, mimeType: mime, capture: CAPTURE });
    console.log(`  ingest 完了 (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  } else {
    const text = readFileSync(resolve(TEXT), 'utf8');
    console.log(`▶ テキスト: ${basename(TEXT)} (${text.length} 字) → ingest 中…`);
    res = await api(token, '/api/meeting/ingest', { transcriptText: text });
    console.log(`  ingest 完了 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);

  writeFileSync(resolve(outDir, 'transcript.txt'), res.transcript ?? '');
  writeFileSync(resolve(outDir, 'minutes.txt'), res.minutes ?? '');
  writeFileSync(resolve(outDir, 'proposals.json'), JSON.stringify(res.proposals, null, 2));

  const lines = [];
  lines.push(`# 会議録音 評価レポート (${stamp})`, '');
  lines.push(`- 入力: ${AUDIO ? basename(AUDIO) : basename(TEXT)}${AUDIO ? ` / capture=${CAPTURE}` : ''}`);
  lines.push(`- 所要: ${totalSec}s（アップロード込み）`);
  lines.push(`- meetingId: ${res.meetingId}（status=reviewing・承認していないので他データは未作成）`);
  lines.push(`- warnings: ${(res.warnings ?? []).join(' / ') || 'なし'}`);
  lines.push(`- 話者: ${(res.speakers ?? []).map((s) => s.label).join(', ') || 'なし'} / 話者交代数: ${speakerTurns(res.transcript ?? '')}`);
  const p = res.proposals ?? {};
  lines.push(`- 候補: つながり ${p.people?.length ?? 0} / 予定 ${p.schedules?.length ?? 0} / タスク ${p.tasks?.length ?? 0}`);
  if (REF) {
    const ref = readFileSync(resolve(REF), 'utf8');
    const { cer: c, refLen, dist } = cer(normalizeForCer(res.transcript ?? ''), normalizeForCer(ref));
    lines.push('', '## 参照文字起こしとの比較');
    lines.push(`- 文字誤り率 CER: **${(c * 100).toFixed(1)}%**（参照 ${refLen} 字・編集距離 ${dist}）※記号/空白/話者ラベル除去後`);
    lines.push(`- 参照側の話者交代数: ${speakerTurns(ref)}`);
    // 自動抽出は話者ラベル（自分/相手/名前）を除いた本文から
    const refBody = ref
      .split('\n')
      .map((l) => l.replace(/^\s*[^\s:：]{1,20}(?:[ 　][^\s:：]{1,20})?\s*[:：]\s*/, ''))
      .join('\n');
    const terms = TERMS ? TERMS.split(',').map((t) => t.trim()).filter(Boolean) : autoTerms(refBody);
    if (terms.length) {
      const hyp = (res.transcript ?? '').normalize('NFKC');
      const hit = terms.filter((t) => hyp.includes(t.normalize('NFKC')));
      const miss = terms.filter((t) => !hyp.includes(t.normalize('NFKC')));
      lines.push(`- 固有名詞/頻出語の一致: ${hit.length}/${terms.length}${TERMS ? '' : '（参照から自動抽出）'}`);
      if (miss.length) lines.push(`  - 未一致: ${miss.join('、')}`);
    }
    lines.push('', '（目安: CER 10% 未満＝実用、5% 未満＝Notta 同等以上。固有名詞の未一致は T9 の用語集ヒントで改善する）');
  }
  lines.push('', '## 議事録', '', res.minutes ?? '(なし)');
  lines.push('', '## 候補（要約）');
  for (const x of p.people ?? []) lines.push(`- 人: ${x.name || '(名前不明)'}${x.customer_id ? '（登録済み）' : ''} / needs=${(x.needs ?? []).join('・')} / wants_to_meet=${(x.custom_fields?.wants_to_meet ?? []).join('・')}`);
  for (const x of p.schedules ?? []) lines.push(`- 予定: ${x.title} ${x.start_at}${x.location ? ` @${x.location}` : ''}`);
  for (const x of p.tasks ?? []) lines.push(`- タスク: ${x.title}${x.due_at ? ` 期限 ${x.due_at}` : ''}`);
  writeFileSync(resolve(outDir, 'report.md'), lines.join('\n'));
  console.log(lines.slice(0, REF ? 14 : 8).join('\n'));
  console.log(`\n📄 詳細: ${outDir}/report.md`);
}

main().catch((e) => {
  console.error('✗', e.message ?? e);
  process.exit(1);
});
