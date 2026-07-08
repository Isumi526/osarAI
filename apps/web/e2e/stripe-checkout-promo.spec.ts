import { test, expect } from '@playwright/test';

// Stripe課金負債台帳 A4 の恒久回帰: promoコードのプラン紐付けを検証しない問題。
// LL2026 は Standard 用（Coupon.metadata.plan=standard・¥1000off）。
// これを Light プランに適用すると誤った過剰割引になっていた（本来の実効価格を超えて安くなる）。
// 前提: `supabase start` + `pnpm dev:web` がローカルで起動済み。
// 前提: LL2026 の Coupon.metadata.plan が 'standard' に設定済み（checkout/route.ts の A4対策と対）。

async function signUpAndReachSubscribe(page: import('@playwright/test').Page, code: string) {
  const email = `e2e-a4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto(`/signup?code=${code}`);
  await page.getByPlaceholder('お名前').fill('E2E Tester');
  await page.getByPlaceholder('メールアドレス').fill(email);
  await page.getByPlaceholder('パスワード（8文字以上）').fill('testpassword123');
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL(/\/subscribe/, { timeout: 15000 });
}

test('promoコードが選択プランと不一致なら checkout を拒否する(A4)', async ({ page }) => {
  await signUpAndReachSubscribe(page, 'LL2026'); // LL2026 = Standard用
  await page.getByRole('heading', { name: 'Light' }).locator('..').getByRole('button', { name: '14日無料で始める' }).click();
  await expect(page.getByText('このコードは選択したプランには使用できません。プランをご確認ください。')).toBeVisible({
    timeout: 10000,
  });
  // Stripeへ遷移していないこと（誤割引セッションが作られていない）
  await expect(page).toHaveURL(/\/subscribe/);
});

test('promoコードが選択プランと一致すれば checkout セッションを作成する(A4)', async ({ page }) => {
  await signUpAndReachSubscribe(page, 'LL2026'); // LL2026 = Standard用
  await page.getByRole('heading', { name: 'Standard' }).locator('..').getByRole('button', { name: '14日無料で始める' }).click();
  // Stripeホスト側ページの完全ロード完了までは待たない(ネットワーク活動が続き'load'待ちが不安定)。
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 15000, waitUntil: 'commit' });
  expect(page.url()).toContain('checkout.stripe.com');
});
