import { test, expect } from '@playwright/test';

// Stripe課金負債台帳 A4 の恒久回帰: promoコードのプラン紐付けを検証しない問題。
// LL2026 は Standard 用（Coupon.metadata.plan=standard・¥1000off）。
// これを Light プランに適用すると誤った過剰割引になっていた（本来の実効価格を超えて安くなる）。
// 前提: `supabase start` + `pnpm dev:web` がローカルで起動済み。
// 前提: LL2026 の Coupon.metadata.plan が 'standard' に設定済み（checkout/route.ts の A4対策と対）。
// phase1でUIがLight単一プランのみ表示になったため(PlanPicker.tsx)、不一致検証は
// UI操作ではなくcheckout APIを直接叩く形にしている（サーバー側の検証自体は
// UIの選択肢を絞った後も維持されていることを回帰確認する）。

async function signUpAndReachSubscribe(page: import('@playwright/test').Page, code?: string) {
  const email = `e2e-a4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto(code ? `/signup?code=${code}` : '/signup');
  // 「名前→ニックネーム」文言変更(2026-07-11)にspecが追随していなかったため修正
  await page.getByPlaceholder('ニックネーム').fill('E2E Tester');
  await page.getByPlaceholder('メールアドレス').fill(email);
  await page.getByPlaceholder('パスワード（8文字以上）').fill('testpassword123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL(/\/subscribe/, { timeout: 15000 });
}

test('promoコードが選択プランと不一致なら checkout を拒否する(A4)', async ({ page }) => {
  await signUpAndReachSubscribe(page, 'LL2026'); // LL2026 = Standard用
  // phase1のUIはLight単一プランのみ表示する。LL2026はStandard向け(metadata.plan=standard)
  // のため、Lightプランへ適用すると過剰割引になる。サーバー側のプラン/promoコード整合性
  // チェックがUIの選択肢を絞った後も引き続き効いていることを確認する回帰。
  const res = await page.request.post('/api/stripe/checkout', {
    data: { plan: 'light', promoCode: 'LL2026' },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe('このコードは選択したプランには使用できません。プランをご確認ください。');
});

test('Lightプランを選ぶと checkout セッションを作成する', async ({ page }) => {
  // 割引コード無しの正常系。UIがLight単一プラン表示になり、その導線がStripe Checkoutへ
  // 到達することの回帰（Light向けpromoコードはStripe側の運用で発行するためここでは使わない）。
  await signUpAndReachSubscribe(page);
  await page.getByRole('heading', { name: 'Light' }).locator('..').getByRole('button', { name: '14日無料で始める' }).click();
  // Stripeホスト側ページの完全ロード完了までは待たない(ネットワーク活動が続き'load'待ちが不安定)。
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 15000, waitUntil: 'commit' });
  expect(page.url()).toContain('checkout.stripe.com');
});
