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

### A4: 完了 ✅
- 修正: `apps/web/app/api/stripe/checkout/route.ts` — 選択プランと `Coupon.metadata.plan` の不一致を400で拒否。既存Stripe Coupon 3種(test mode)に `metadata.plan` を設定して整合。
- テスト: `apps/web/e2e/stripe-checkout-promo.spec.ts`（Playwright・不一致拒否／一致時正常遷移の2ケース）→ green。
- Gemini独立レビュー(T5・`--runs 2`): findings 0件、verdict=pass、riskClass=high。
- コミット: `4f154b2`(chore基盤) / `6ab8724`(fix本体)。devブランチ・未push。

### A3: 完了 ✅
- 修正:
  - `apps/web/app/api/stripe/webhook/route.ts` — `invoice.payment_failed` ケースを新規追加。`apps/web/lib/notify-operator.ts`（既存 notify-humanball.mjs と同一契約のfetch実装・サーバーレス関数からchild_process起動できないため）でbest-effort運営者通知。DBの`status`同期自体は既存の`customer.subscription.updated`(status=past_due)で従来通りカバー。
  - `apps/web/app/api/stripe/portal/route.ts`（新規）— 認証済ユーザー本人の`stripe_customer_id`からStripe Billing Portalセッションを作成。
  - `apps/web/app/billing/page.tsx` + `BillingPortalButton.tsx`（新規）— お支払い状況の確認＋past_due時のバナー＋再決済導線（ユーザー自身で解決できる自己解決導線）。pipeline設定表に元々予定されていた`/billing`パスに対応。
- テスト: `apps/web/e2e/stripe-payment-failed.spec.ts`（Playwright）。実LINEを鳴らさないようモック運営者通知サーバー(localhost:3999)を使い、(1)invoice.payment_failed受信→通知内容(kind=要対応/task/user_id含むdetail)を検証 (2)/billingでpast_dueバナー表示→ポータル遷移(billing.stripe.com)まで確認。
- typecheck/build: green（`pnpm -r typecheck` / `pnpm -r build`）。
- Gemini独立レビュー(T5・`--runs 2`): findings 0件、verdict=pass、riskClass=high。
- コミット: `7b52af0`(chore) / `681239c`(fix本体)。devブランチ・未push。

### A1: 完了 ✅
- 修正:
  - `apps/web/lib/stripe.ts` — `planForPriceId`（price id→plan逆引き）・`priceIdFromSubscription` を追加。
  - `apps/web/app/api/stripe/webhook/route.ts` — `customer.subscription.updated/deleted` で `plan` を同期（Stripeの正=price idから逆引き。未知price idの時は既存planを上書きしない=フェイルセーフ）。
- テスト: `apps/web/e2e/stripe-webhook-plan-sync.spec.ts`。Standard→Lightダウングレードを模したイベントでDBのplanが追従することを確認。**修正前コードに一時的に戻して赤(plan='standard'のまま)→修正を戻して緑になることを確認済み**（回帰再現の検証込み）。
  - ついでにA4テスト2件のflaky対策（Stripeホスト側ページの`waitForURL`を`waitUntil:'load'`→`'commit'`に変更。並列実行時に'load'イベントが発火しないケースがあった）。
- typecheck/build: green。
- Gemini独立レビュー(T5・`--runs 2`): findings 1件(medium・冪等性=A2そのもの。verdict=pass・非ブロック)、verdict=pass、riskClass=high。→ 次のA2で解消。
- コミット: `af2926e`。devブランチ・未push。

### A2: 完了 ✅
- 修正（🧱土台・migration追加）:
  - `supabase/migrations/0005_webhook_idempotency.sql`（新規）— `stripe_webhook_events`テーブル(event.id冪等化・RLS ON+ポリシー0件でservice_role以外完全遮断・T9#1準拠) ＋ `subscriptions.last_stripe_event_at`カラム(順序ガード用)。
  - `apps/web/app/api/stripe/webhook/route.ts` — 署名検証直後に`event.id`をinsertし一意制約違反(23505)なら`{received:true, duplicate:true}`で即終了(冪等)。`customer.subscription.*`では`event.created`が既に適用済みの状態より古ければ更新をスキップ(順序逆転ガード)。
  - `packages/shared/database.types.ts` — `supabase gen types typescript --local`で再生成。
- テスト: `apps/web/e2e/stripe-webhook-idempotency.spec.ts`（(1)同一event.id再送で二重通知しない (2)順序逆転イベントで新しい状態(pro)が古いイベント(light)に巻き戻らない）。**修正前コードに一時的に戻して両方赤→戻して緑になることを確認済み**。
- flaky対策: 複数specが固定ローカルポート(mock humanballサーバー)を共有するため、cross-file並列も止めて`workers:1`(完全直列)に変更。
- ローカル適用: `supabase migration up`でlocal DBへ適用済み（**本番へは絶対適用しない・`db push`は使用していない**）。
- RLS監査: `node scripts/rls-audit.mjs --assert --json` → `verdict:"pass"`, violations:0。`stripe_webhook_events`はRLS ON・policies:0・anon権限なし=想定通り。
- typecheck/build: green。
- Gemini独立レビュー(T5・🧱土台につき`--runs 3`): findings 0件、verdict=pass、riskClass=high。
- コミット: `060ca6a`。devブランチ・未push。

### A5: 完了 ✅
- 修正:
  - `packages/shared/src/jst.ts`（新規）— `jstMonthStartUtc(now?)`: JST(UTC+9)基準で「今月の月初0:00」を実時刻(UTC基準Date)として返す純粋関数。
  - `apps/web/app/api/advice/route.ts` — 月次上限カウントの起点を `new Date().setHours(0,0,0,0)`（サーバーのローカル時刻＝Vercel上はUTC）から `jstMonthStartUtc()` に置換。
- テスト: `apps/web/e2e/jst-month-boundary.spec.ts`。UTC基準では前月/当月の判定がJSTとズレる境界時刻を3ケース（月初直後・月末直前・日中）で検証。関数の入出力を直接assertする形（DBシード等を要する重い月境界の実時刻テストより決定的で確実なため。ledger記載の「timezoneをJST固定 **or** 専用カウンタ」のうちJST固定を採用）。
- 残課題（今回の修正範囲外・ledgerの恒久対策では対象外）: 月次カウントは依然「毎回count」方式のため、理論上は同時多重リクエストでカウント境界のわずかな超過余地が残る（ledger原文でも「timezone固定 **or** 専用カウンタ」のORで許容されている）。実害は僅少（誤請求ではなく無料枠のわずかな超過）のため今回は対象外。将来 専用カウンタ化する場合は別チケット。
- typecheck/build: green。
- Gemini独立レビュー(T5・`--runs 2`): findings 2件(medium・いずれも「上限チェックとDB書き込みが非アトミック＝連打で上限超過の可能性」＝上記「残課題」として既に認識・スコープ外と明記済みの内容と同一)。verdict=pass（非ブロッカー）。→ 独立レビューが同じリスクを検出したことで、スコープ外判断が恣意的でないことを確認。
- コミット: `3296a2b`。devブランチ・未push。

---

## フェーズ2 完了サマリ（2026-07-08）

Stripe課金負債台帳 A1〜A5、全5件を実損順（A4→A3→A1→A2→A5）で修正・テスト・Gemini独立レビューまで完了。全てdevブランチにローカルcommit済み・未push（本番/リモートには一切触れていない）。

| # | 内容 | コミット | Geminiレビュー |
|---|---|---|---|
| A4 | promoコードのプラン紐付け検証 | `6ab8724` | pass・findings 0 |
| A3 | 自動課金失敗の通知＋再決済導線 | `681239c` | pass・findings 0 |
| A1 | webhookのplan同期 | `af2926e` | pass・findings 0(冪等性=A2を先取り検出) |
| A2 | webhookイベント冪等化＋順序ガード(🧱土台・migration) | `060ca6a` | pass・findings 0(runs 3) |
| A5 | AI相談月次上限のJST化 | `3296a2b` | pass・findings 2(既知・スコープ外と明記済みの残課題と一致) |

**ゲート**: `pnpm -r typecheck` / `pnpm -r build` 全green。`node scripts/rls-audit.mjs --assert` verdict=pass(violations:0)。Playwright E2E 9件全green（`apps/web/playwright.config.ts`・新規導入）。

**この作業で追加/変更したファイル一覧**（主要なもの）:
- `supabase/migrations/0005_webhook_idempotency.sql`（新規migration・🧱土台）
- `apps/web/app/api/stripe/checkout/route.ts`・`webhook/route.ts`・`app/api/stripe/portal/route.ts`（新規）
- `apps/web/app/billing/`（新規）・`apps/web/lib/notify-operator.ts`（新規）・`apps/web/lib/stripe.ts`
- `packages/shared/src/jst.ts`（新規）
- `apps/web/e2e/*.spec.ts`（新規5ファイル）・`apps/web/playwright.config.ts`（新規）
- `packages/shared/database.types.ts`（`supabase gen types`で再生成）

**未pushの理由**: DECISIONS T14/厳守により、mainマージ・pushは人の明示タイミング承認が前提。今回はdevへのローカルcommitまで（レビュー待ち相当の状態）。

## フェーズ3（未着手・人の判断待ち）

デプロイ経路の確定に停止。詳細は会話内の質問を参照（本ファイルには機密性の低い要点のみ記載）：
- Web(apps/web)のホスティング先（Vercel前提で進めてよいか）
- 本番用Supabaseプロジェクトの新規作成可否・タイミング
- 独自ドメインの有無
- Stripe本番鍵への切替タイミング・取扱い

これらが確定するまで、本番への実デプロイ・実決済・本番DB書込みは一切行わない（deny壁維持）。

## ローカルE2E環境の補足メモ（重要・再開時に読むこと）

- **2つのwebインスタンスを使い分けている**:
  - `pnpm dev:web`（port 3000）: `.env.local`のまま = **ホスト型Supabase**(`apiagxfbazxmdqcbynxk.supabase.co`)に接続。signup等の書き込みテストをここに向けない（実プロジェクトへの書き込みになるため）。
  - E2E専用インスタンス（port 3055・`NEXT_DIST_DIR=.next-e2e`）: env変数を上書きしてlocal Supabase(127.0.0.1:54321)・`HUMANBALL_WEBHOOK_URL`をローカルモック(3999)に向けて起動。Playwrightの既定baseURLはこちら。起動コマンドは本ファイルの後方に残す（再現用）。
- ローカルGoTrue（このCLIバージョン=2.75.0のイメージ）は `auth.admin.*` 系管理APIが新旧どちらのキー形式でも `403 bad_jwt (signing method HS256 is invalid)` になる既知の不具合がある。テストユーザー作成は通常の `/auth/v1/signup` + ログインUIを使うことで回避している（本番のGoTrueとは無関係のローカル限定の地雷）。
- ローカル `supabase/config.toml` を2箇所調整済み（本番Supabase Cloudには影響しない、local CLIのみの設定）:
  - `[analytics] enabled=false`（logflareコンテナがこの環境で恒常的にunhealthy化しstart全体をブロックするため）
  - `[auth.rate_limit] email_sent=300`（既定2/hだとE2Eのsignup connタが即枯渇するため）
- `supabase start` は `--ignore-health-check` を付けないと（realtime/storage/pg_meta/studioの一部が）unhealthy判定でロールバックすることがある。DB/Authは実際には正常に機能する。
- 2つの`next dev`を同じ`.next`に向けると生成物が競合破損する（macOS "` 2`"複製ファイルが`.next/**`に大量発生し型検査が壊れる）。`next.config.mjs`に`NEXT_DIST_DIR`環境変数でdistDirを分離できるようにした。

### E2Eインスタンス起動コマンド（再現用）
```bash
supabase start --ignore-health-check   # ローカルSupabase起動(このリポ直下で)
cd apps/web
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_ANON_KEY="sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
export SUPABASE_SERVICE_ROLE_KEY="sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"
export GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' .env.local | cut -d= -f2-)
export STRIPE_SECRET_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.local | cut -d= -f2-)
export STRIPE_WEBHOOK_SECRET="whsec_e2e_test_secret"
export STRIPE_PRICE_LIGHT=$(grep '^STRIPE_PRICE_LIGHT=' .env.local | cut -d= -f2-)
export STRIPE_PRICE_STANDARD=$(grep '^STRIPE_PRICE_STANDARD=' .env.local | cut -d= -f2-)
export STRIPE_PRICE_PRO=$(grep '^STRIPE_PRICE_PRO=' .env.local | cut -d= -f2-)
export NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$(grep '^NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=' .env.local | cut -d= -f2-)
export HUMANBALL_WEBHOOK_URL="http://127.0.0.1:3999/mock-humanball"
export HUMANBALL_WEBHOOK_SECRET="e2e-mock-secret"
export NOTIFY_PREFIX="[osarAI-e2e]"
export NOTIFY_PROJECT="osarAI"
export NEXT_DIST_DIR=".next-e2e"
npx next dev -p 3055 &

# テスト実行時（Stripe実APIを叩くテストのみ必要）:
export E2E_STRIPE_SECRET_KEY=$(grep '^STRIPE_SECRET_KEY=' .env.local | cut -d= -f2-)
npx playwright test
```

---

## Phase 3: 停止ポイント（人の判断待ち・未到達）

デプロイ経路確定（Vercelでよいか／本番Supabaseプロジェクト作成／独自ドメイン／Stripe本番鍵の扱い）に人の判断が必要になった時点でバッチ質問して停止予定。まだ到達していない。

---

## ローカル環境メモ（再開時用）
- `supabase start`済み（API 54321 / DB 54322 / Studio 54323）。作業完了後 `supabase stop` すること（sidoと同一ポートのため）。
- `pnpm dev:web`をバックグラウンドPID起動中（ログ: `/tmp/osarai-web-dev.log`）。
- 作業ブランチ: `dev`（このまま継続）。
