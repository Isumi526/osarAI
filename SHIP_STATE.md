# SHIP_STATE.md — Stripe課金負債台帳（A1-A5）修正 進捗ログ

方針: osarAI本番未リリース・実ユーザー/実決済ゼロのため、フェーズ1〜2は人承認なしでノンストップ実行。
実装順=実損順: **A4→A3→A1→A2→A5**。各修正: Gemini独立レビュー(🔴高相当) + 再現/回帰検証を実施。
devブランチ作業。本番デプロイ・実決済・本番DB書込みは一切行わない（deny壁維持）。

参照元: `~/cc-pipeline/products/osarai/CLAUDE.md`「Stripe課金の負債台帳」/ `~/cc-pipeline/DECISIONS.md`。

---

## Phase 1: ローカル起動 + A1〜A5現状確認 + A4再現（完了）

### ローカル環境の地雷対応
- macOS `" 2"` 複製ファイル12個を削除（`products/osarai/CLAUDE.md`記載の既知地雷）。
  - 8個: 現行版とbyte-identical（Finderクローン、実体なし）。
  - 4個（`CustomerDetail 2.tsx` / `Home 2.tsx` / `transcribe/route 2.ts` / `push-fcm 2.ts`）: push-fcmはFCM legacy→v1移行前、transcribeはentitlementゲート追加前の**旧版スナップショット**と確認（現行版が後発コミットで上書き済み・現行版が正）。削除して安全。
  - `supabase/migrations/0004_storage_recordings 2.sql` も現行版とidentical→削除（db reset破壊の既知地雷を解消）。
- ポート競合: `sido`プロジェクトのlocal Supabaseが54322を占有 → `supabase stop --project-id sido`で一旦停止（データはdocker volumeに保持・再開時は `supabase start` でsido側から起動し直せば復元）→ osarAI側 `supabase start` 成功（migrations 0001-0004自動適用）。
- `pnpm install`（差分なし）・`pnpm -r typecheck` green・`pnpm dev:web`起動確認（`/api/health` 200）。

### A1〜A5 現状確認（コード読み込みで全件確認）
| # | 事象 | 現状確認結果 |
|---|---|---|
| A1 | webhook `customer.subscription.updated/deleted` が `plan` を同期しない | 確認: `apps/web/app/api/stripe/webhook/route.ts` の該当caseは `status`/`trial_end`/`current_period_end`のみupdate。`plan`フィールド無し。 |
| A2 | webhook イベント冪等化なし | 確認: `webhook/route.ts`に`event.id`の処理済みチェック無し。Stripe再送/順序逆転で`checkout.session.completed`の`upsert`後に古い`subscription.updated`が後着すると状態が巻き戻る余地あり。 |
| A3 | 自動課金失敗ハンドリング無し | 確認: `webhook/route.ts`のswitchに`invoice.payment_failed`のcase自体が存在しない（default握りつぶし）。 |
| A4 | promoコードのプラン紐付け未検証 | **確認+再現**: `checkout/route.ts`は`promotionCodes.list({code})`で引いた`promotion_code`をplanと無関係にそのまま適用。Stripe test環境で実証：`plan=light`（¥1980・LL提携価格は¥500off→¥1480想定）に`promoCode=LL2026`（Standard用¥1000off）を適用→**session作成が拒否されずそのまま成功**（`cs_test_a1w66g...`）。実効¥980/月で本来より¥500/月の請求漏れが恒久的に発生（coupon duration=forever）。Stripe Coupon側に`applies_to`制約が設定されていないため、コード文字列だけ合っていればどのプランにも適用されてしまう。 |
| A5 | AI相談月次上限がサーバーローカル時刻基準 | 確認: `apps/web/app/api/advice/route.ts`が`new Date()`でmonthStart算出（Vercel=UTC想定）。JSTとの9時間ズレで月初/月末付近にカウント境界がずれる。 |

**現存 Stripe設定**（test mode）確認: Coupon 3種（LL Light ¥500off / LL Standard ¥1000off / LL Pro ¥2000off）・Promotion Code `LL2026`→LL Standard紐付け・Price 3種（Light¥1980/Standard¥3980/Pro¥6980）全て`§0 B-1`の想定どおり存在。**いずれのCouponにも`applies_to`（対象product制限）が未設定** = A4の根本原因。

---

## Phase 2: 修正（実損順 A4→A3→A1→A2→A5）

### A4: 進行中
(更新予定)

### A3 / A1 / A2 / A5: 未着手

---

## Phase 3: 停止ポイント（人の判断待ち・未到達）

デプロイ経路確定（Vercelでよいか／本番Supabaseプロジェクト作成／独自ドメイン／Stripe本番鍵の扱い）に人の判断が必要になった時点でバッチ質問して停止予定。まだ到達していない。

---

## ローカル環境メモ（再開時用）
- `supabase start`済み（API 54321 / DB 54322 / Studio 54323）。作業完了後 `supabase stop` すること（sidoと同一ポートのため）。
- `pnpm dev:web`をバックグラウンドPID起動中（ログ: `/tmp/osarai-web-dev.log`）。
- 作業ブランチ: `dev`（このまま継続）。
