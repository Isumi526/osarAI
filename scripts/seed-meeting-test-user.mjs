// 会議録音のローカル手動テスト用シード。local Supabase に
// 「Standard・trialing の契約済みテストユーザー」を作る（会議録音は Standard 以上のゲート）。
// 使い方: node scripts/seed-meeting-test-user.mjs [email] [password]
// 既定 email=meeting-test@example.com / pass=testpassword123
const URL = 'http://127.0.0.1:54321';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const email = process.argv[2] || 'meeting-test@example.com';
const password = process.argv[3] || 'testpassword123';

async function main() {
  // 1) service_role で確認済みユーザーを作成（メール確認をスキップ）
  const adminHdr = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' };
  let userId;
  const createRes = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHdr,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (createRes.ok) {
    userId = (await createRes.json()).id;
    console.log(`✅ ユーザー作成: ${email}`);
  } else {
    // 既存なら取得
    const list = await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: adminHdr });
    const found = (await list.json()).users?.find((u) => u.email === email);
    if (!found) throw new Error(`ユーザー作成失敗: ${await createRes.text()}`);
    userId = found.id;
    console.log(`ℹ️ 既存ユーザーを使用: ${email}`);
  }

  // 2) profile(org自動生成) を待って org_id を取得
  let orgId;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${URL}/rest/v1/profiles?id=eq.${userId}&select=org_id`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    const rows = await r.json();
    if (rows?.[0]?.org_id) { orgId = rows[0].org_id; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(`✅ org_id=${orgId}`);

  // 3) Standard・trialing の subscription を service_role で upsert（14日トライアル）
  const trialEnd = new Date(Date.now() + 14 * 864e5).toISOString();
  const periodEnd = trialEnd;
  const subRes = await fetch(`${URL}/rest/v1/subscriptions`, {
    method: 'POST',
    headers: { ...adminHdr, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ user_id: userId, plan: 'standard', status: 'trialing', trial_end: trialEnd, current_period_end: periodEnd }),
  });
  if (!subRes.ok) throw new Error(`subscription upsert 失敗: ${await subRes.text()}`);
  console.log(`✅ subscription: standard / trialing (trial_end=${trialEnd.slice(0, 10)})`);

  console.log('\n=== ログイン情報 ===');
  console.log(`  email   : ${email}`);
  console.log(`  password: ${password}`);
  console.log('会議録音(Standard機能)が使えます。web を local Supabase 向けに起動してログインしてください。');
}
main().catch((e) => { console.error('✗', e); process.exit(1); });
