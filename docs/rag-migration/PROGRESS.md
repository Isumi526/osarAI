# RAG移行プロジェクト 進捗管理

最終更新: 2026-08-13

## 現在のフェーズ

Phase 1-A の事前調査 ＋ Phase 0 手順1〜2（並行実施中）

## フェーズ一覧

| Phase | 内容 | 状態 | 完了日 |
|---|---|---|---|
| 0 | 診断ロジックの新規設計（カテゴリ・設問・分岐規則の確定） | 進行中（手順1〜2） | - |
| 1-A | プロジェクト雛形・/healthz | 事前調査中 | - |
| 1-B | RAGコア実装 | 未着手 | - |
| 2 | 評価設計・Next.js統合 | 未着手 | - |
| 3 | AWS デプロイ・IaC | 未着手 | - |
| 4 | ドキュメント整備 | 未着手 | - |

## 事前調査の結果

（Phase 1-A の事前調査で判明した内容をここに記録）

### 既存の RLS ポリシーの書き方

調査日: 2026-08-13。

- **テナント解決は JWT claims ではなく `profiles` 参照。** `current_org_id()` / `current_user_role()`
  （`0002_rls.sql:10-18`）が `security definer` + `set search_path = public, pg_temp` で
  `select org_id from profiles where id = auth.uid()`。**カスタムクレームは未使用**
  （`auth.jwt()` / `app_metadata` の使用箇所はリポジトリ全体で0件。
  `supabase/config.toml:264-266` の `custom_access_token` フックはコメントアウトのまま）。
- **命名規則**: 世代差あり。0002 は略称（`osarai_own` / `subs_own` / `aichatmsg_own`）だが、
  0008 以降は**フルテーブル名前置**（`schedules_select` / `tasks_cud` / `assistant_sessions_own`）。
  **新規追加は後者に従う。**
  - パターンA（org スコープ・leader 閲覧あり）: `<table>_select` + `<table>_cud`(`for all`) の2本組
  - パターンB（本人専用）: `<table>_own`(`for all`) の1本
- **`using` と `with check` は同じ述語で揃える。** これは 0020/0021 で
  「`using` に所有者条件が無く DELETE が素通りしていた」バグを 0022 で修正した経緯からの教訓
  （`0022_agency_products_referral_codes_own_only.sql:2-4`）。
- **所有者列の使い分け**: `owner_id`＝持ち続けるエンティティ（customers/schedules/tasks）／
  `author_id`＝書いた記録（interactions）／`user_id`＝本人専用セッション・設定／
  `created_by`＝代理店系（agency_products/referral_codes）。
- **インデックスは無名 `create index on <table>(<col>);`**（式インデックスのみ命名＋`if not exists`）。
- **`grant` は書かない。** `0014_default_grants.sql:20-24` の `alter default privileges` が自動適用。
  なお `0014:15` の `grant ... on all tables` が `0005:18` / `0006:11` の `revoke` を後から
  打ち消している（RLS ON + ポリシー0本なので実害なし）。
- **service_role 前提のテーブル**: `stripe_webhook_events`(0005) / `cron_runs`(0006)。
  RLS ON + ポリシー0本＝default deny。`createServiceRoleClient()` の使用は
  stripe webhook / cron 4本 / transcribe の Storage 操作のみ。
- **customer_id を持つテーブルを足したら `0027_merge_customers_fn.sql:45-50` の
  付け替えリストにも追加する規約**（コメントで明記）。

→ `rag_documents` / `rag_chunks` / `diagnosis_runs` のポリシー雛形案あり（Phase 1-A ステップ2で使用）。

### Next.js 側の認証処理

調査日: 2026-08-13。唯一の認証ヘルパは `apps/web/lib/api-auth.ts`（全59行）。

- **検証方法は JWKS 自前検証ではなく `supabase.auth.getUser(token)`**（`api-auth.ts:34`）。
  Auth サーバーへの HTTP ラウンドトリップで、失効・削除・ban が即座に反映される。
- **返り値は `{ supabase, user }` の2つだけ**（`api-auth.ts:13-16`）。**org_id も role も含まれない。**
- **クライアントは anon キー + ユーザートークン**＝ PostgREST 呼び出しが RLS でスコープされる。
  `api-auth.ts:1-4` に「service_role は使わない（テナント/owner 分離は RLS に委ねる）」と明記。
- **エラー契約**: 未認証は `{error:'unauthenticated'}` + 401。
  400=バリデーション / 402=`subscription_required` / 403=`plan_upgrade_required` /
  404 / 413=ペイロード過大 / 429=上限 / **502=外部API(Gemini)失敗** / 500=DB失敗。
  外部API失敗時は `detail` にエラー文字列を載せてクライアントへ返す方針。
- **CORS は `Access-Control-Allow-Origin: '*'` 固定**（`api-auth.ts:48-58`）。環境変数制御なし。
  Capacitor の `capacitor://localhost` 対策。`Allow-Credentials` は付けない（`*` と併用不可のため正しい）。
- **cron は共有シークレット方式**で「未設定時の素通しフォールバック禁止」が明文化
  （`cron/remind/route.ts:3,17-24`）。ただし `auth !== ...` は非定数時間比較。

### 環境変数の管理方法

調査日: 2026-08-13。

- **正本は `.env.example`**（46行）。`:6-8` に鉄則: service_role / GEMINI / STRIPE_SECRET は
  サーバーのみ。`NEXT_PUBLIC_` / `VITE_` はバンドルに焼き込まれる＝公開可の値のみ。
  CLAUDE.md §13 のリストは陳腐化している（旧 `FCM_SERVER_KEY` / `APNS_*` のまま）。
- **起動時バリデーションは無い。** `process.env.X!` は0箇所だが、代わりに
  `?? ''`（Supabase系・`lib/supabase/server.ts:10-11`）で黙って空文字になり、実行時に失敗する。
  Gemini / Stripe は遅延チェック＋例外（`lib/gemini.ts:11-15` / `lib/stripe.ts:1-16`）。
  → **FastAPI では pydantic-settings で fail-fast にし、この弱点を継承しない。**
- **`.env.example` に未記載だが実装が使っているキー**: `CRON_SECRET` / `NEXT_PUBLIC_APP_URL` /
  `HUMANBALL_WEBHOOK_URL` / `HUMANBALL_WEBHOOK_SECRET` / `NOTIFY_PREFIX` / `NOTIFY_PROJECT` /
  `NEXT_DIST_DIR` / `E2E_BASE_URL`。
- **モバイル(Vite)に秘密の混入なし。** `import.meta.env` の使用は5箇所で全て `VITE_` 接頭辞。
  ただし `apps/mobile/.env` はルート `.env` への**シンボリックリンク**なので、
  `envPrefix` を緩めたり `define` を足すと即座に漏洩する構成。
- **Vercel**: 機密値の投入は人がダッシュボード/CLI で実施（`vercel env add --sensitive`）。
  Git 連携なし＝`npx vercel --prod --scope stism` の手動デプロイ。

### 課金プランの判定ロジック

調査日: 2026-08-13。**⚠️ 重大な欠落を3件検出（詳細は「ブロッカー・確認待ち」）。**

- **プラン定義**: `packages/shared/src/plans.ts`。機能フラグは3つだけ
  （`aiAdviceLimit` / `recordingImport` / `leaderDashboard`）。
  light=10回・録音不可 / standard=無制限・録音可 / pro=＋leaderDashboard / member=10回。
  - `leaderDashboard` は**定義されているだけでどこからも参照されていない**（死んだフラグ）。
    実際のダッシュボード保護は role/RLS 側。
  - `light` と `standard` の `listPrice` がどちらも 1980（`plans.ts:21,29`）。仕様意図か要確認。
- **「利用可」の判定は `ACTIVE_SUB_STATUSES = ['trialing','active']`（`plans.ts:73`）の文字列比較のみ。**
  `current_period_end` / `trial_end` は保存されているが**判定に使われていない**
  → Stripe webhook が届かなければ `active` のまま無期限に通る。
- **サーバー側の砦は `apps/web/lib/entitlement.ts:14-26` の `getEntitlement()`** 1箇所。
  `apps/mobile/src/lib/subscription.ts:13-26` は同一ロジックの複製（導線出し分け用と明記）。

#### 利用回数カウントの検証結果

実装は **`apps/web/app/api/advice/route.ts:49-67` の1箇所のみ**。
`ai_chat_messages` の `role='user'` 行を JST 月初以降で `count`。専用カウンタ表は存在しない。

| 論点 | 判定 | 根拠 |
|---|---|---|
| (a) タイムゾーン境界 | **解消済み** | `advice/route.ts:54` が `jstMonthStartUtc()` を使用。`packages/shared/src/jst.ts:8-12` は `getUTC*` のみでサーバーローカル時刻に非依存。対象列は `timestamptz`。回帰テスト `apps/web/e2e/jst-month-boundary.spec.ts` あり |
| (b) 競合（race） | **未修正・残存** | `:56-60`(SELECT count) と `:95`(INSERT) の間にアトミック性なし。DB にカウンタ表・一意制約・`UPDATE...RETURNING`・トランザクションのいずれも無い。並列 N リクエストで上限を N まで超過可能。`SHIP_STATE.md:81` で作者自身が「対象外」と明記 |
| (c) 統合チャット経由のバイパス | **未修正・残存（最も重大）** | `apps/web/app/api/assistant/turn/route.ts:171-176` は `ent.active` のみ。`aiAdviceLimit`/`ai_chat_messages` の参照が**0件**。`assistant_sessions.ai_chat_id`(`0026:43`) へのミラー保存も**全コードで未実装**。`/chat` が現行主導線（`apps/mobile/src/App.tsx:34`）＝**並列リクエスト不要で通常操作から無制限に相談できる** |
| (d) fail-open | **残存** | `advice/route.ts:49` `ent.def?.aiAdviceLimit ?? null` と `transcribe/route.ts:83` `if (ent.def && ...)` は `def===null` で素通り。`stripe/webhook/route.ts:54,90` は plan 未解決時 null を保存しうる |

(c) は設計文書 `docs/redesign-2026-08-06-plan.md:208-213,419` で
「Light プラン上限との互換（consult ミラー保存）」として**リリース前必須**と指定されていたが、
実装されないままリリースされている。

**⚠️ SPEC.md 3.5 の「利用回数制限は UTC 基準で実装」は既存実装と食い違う。**
実装は **JST 基準**を採用済み（`SHIP_STATE.md:80`「ledger記載のうち JST 固定を採用」）。
日本向けサービスとしては JST 固定が正しく、SPEC 側の記述が誤り。Phase 2 着手時に修正する。

### 既存の AI診断ロジック

**調査日: 2026-08-12 / 判定: C（未実装 — コードが存在しない）**

SPEC.md 0.1 が前提とする「13問・12カテゴリ分岐のルールベース AI診断」は、
**このリポジトリに存在しない**。移植元が無いため、Phase 1-B の `diagnosis/rules.py` は
「移植」ではなく「新規設計」になる。

#### 1. 横断検索の結果（すべて 0 件）

| 検索対象 | 方法 | 結果 |
|---|---|---|
| ファイル名 | `git ls-files \| grep -iE "shindan\|diagnos\|assess\|診断"` | 0 件 |
| 追跡ファイルの内容 | `git grep -ilE "診断\|shindan\|diagnos\|assessment"` | 0 件 |
| **全ローカルブランチ**（36本）の内容 | `git grep -ilE "診断\|shindan\|diagnos" <全ブランチ>` | 0 件 |
| 作業ツリー全体（未追跡ファイル含む・`docs/` 除く） | `grep -rilE "診断\|shindan\|diagnos"` | 0 件 |
| コミットサブジェクト（全ブランチ・145 commits） | `git log --all --format='%s' \| grep -iE "診断\|diagnos\|shindan\|assess\|設問"` | 0 件 |

- grep 自体の健全性は「おさらい」で対照確認済み（5ファイル hit）。
- リモートブランチ（origin/*）はすべて対応するローカルブランチが存在するため、上記でカバー済み。
- **13個の要素を持つ設問配列・12個の分岐/カテゴリ定数も発見できず。**
  `packages/shared/src` / `apps/web/lib` 内の大文字定数配列は
  `RETRY_DELAYS_MS = [800]`（Gemini リトライ間隔）1件のみ。
  「カテゴリ」の語が出るのは**スケジュール分類**（`schedules.ts` / `Schedule.tsx` 等）で、診断とは無関係。

#### 2. 既存 AI 機能の実態（＝ B ではない理由）

| 機能 | 実装 | 形式 | 設問数 | 分岐数 | 出力生成 |
|---|---|---|---|---|---|
| おさらい対話 | `api/osarai/turn` + `prompts/osarai.ts` | **自由対話**（LLM が毎ターン次の質問を1つ生成） | **固定設問なし** | なし | **LLM 生成**（Gemini・JSON） |
| 自分をおさらい | `api/self-osarai/turn` + `prompts/self-osarai.ts` | 自由対話（明示的に「フォーム的に問い詰めない」と指示） | 固定設問なし | なし | LLM 生成 |
| AI戦略相談 | `api/advice` + `prompts/advice.ts` | 自由チャット | なし | なし | LLM 生成 |
| 顧客登録AI解析 | `api/customers/analyze` | テキスト/画像からの抽出 | なし | なし | LLM 生成 |
| アポ戦略提案（cron） | `api/cron/apo-strategy` | 通知バッチ | なし | なし | LLM 生成 |

いずれも**設問形式ではなく自由対話／自由入力**であり、**カテゴリ分岐も固定文面テーブルも持たない**。
したがって「おさらい対話・AI戦略相談が実質的に AI診断に当たる」（判定 B）とは言えない。

唯一のルールベース分岐は `packages/shared/src/temperature.ts`
（`computeAutoTemperature()`: 直近接触日と予定件数から hot/warm/cold を算出）だが、
**3分岐**であって 12カテゴリではなく、診断ではなく顧客の温度感ラベル用。

#### 3. Supabase スキーマ（migrations 0001〜0027）

診断結果を保存するテーブルは**存在しない**。
関連しうるテーブルは `osarai_sessions`（対話ログ）／`interactions`（対応履歴・`ai_summary jsonb`）／
`ai_chats` + `ai_chat_messages`（相談ログ）／`assistant_sessions`（0026）で、
いずれも自由対話のログであり、設問回答・診断カテゴリ・診断結果を持つ構造ではない。

#### 4. 重要な指摘（SPEC.md と実装の食い違い）

1. **SPEC.md 0.1「現在ルールベースで実装されている」は事実に反する。**
   移行元が無いため、本プロジェクトは「ルールベース → RAG への移行」ではなく
   **「AI診断機能の新規構築（ルールベース骨格 + RAG）」**である。

2. **SPEC.md 0.2「法務リスク：現状はルールベースで回避」も成立していない。**
   既存の おさらい／相談／アポ戦略 は既に LLM が自由生成しており、
   出典グラウンディングもガードレール（禁止表現チェック）もディスクレーマーも実装されていない
   （`forbidden` / `guardrail` / `保証` の grep hit は cron の認証コメントと利用規約ページのみ）。
   → 「安全な骨格から出発する」という前提が無い。**現状の方がむしろ法務リスクは高い**。

3. 上記2点により、**Phase 1-B に着手する前に「13問・12カテゴリ・分岐規則・各カテゴリのベース文面」を
   人が決める工程（新設 Phase 0）が必要**。これは仕様判断であり CC が独断で決めてはならない。
   Phase 2 のゴールデンデータセット（`expected_category`）もカテゴリ定義に依存するため、
   ここが未定だと最重要フェーズである Phase 2 が着手不能になる。

### 環境変数の管理方法

（未調査）

## 次にやること

Phase 1-A の事前調査のうち、残り4項目（RLS / Next.js認証 / 課金プラン判定 / 環境変数）。
ただし下記ブロッカーの回答を待ってから進める。

## ブロッカー・確認待ち

### [🔴 要対応・2026-08-13] 事前調査中に検出した既存実装の欠陥（RAG移行とは独立）

本プロジェクトの事前調査の副産物。**RAG移行より優先度が高い可能性がある**ため記録する。
いずれも修正は未着手（調査のみ）。

| # | 内容 | 場所 | 状態 |
|---|---|---|---|
| S1 | **権限昇格**: member が自分の `role` を `leader` に自己UPDATEでき、org全体の顧客・履歴・予定・タスクが閲覧可能になる | `supabase/migrations/0002_rls.sql:37-38`（`profiles_update` に `with check` が無い） | **ローカルで実証済み**（0件→66件。トランザクションはrollback済み） |
| S2 | **課金上限の完全バイパス**: `/chat`（現行主導線）から回数無制限にAI相談が使える | `apps/web/app/api/assistant/turn/route.ts:171-176` | 未修正。設計文書で「リリース前必須」とされた実装が欠落 |
| S3 | **LLM出力に防御機構が一切ない**: 禁止事項の記述・safetySettings・UI免責・内容検証・通知本文の監査ログ、すべて無し | `packages/shared/src/prompts/*.ts`、`apps/web/lib/gemini.ts`、`apps/mobile/src/screens/*` | 未修正 |
| S4 | 回数制限の競合（並列リクエストで上限超過） | `apps/web/app/api/advice/route.ts:56-60` vs `:95` | 未修正（既知・`SHIP_STATE.md:81` で「対象外」と明記） |
| S5 | プラン未解決(`plan=null`)時に機能ゲートが fail-open | `advice/route.ts:49`、`transcribe/route.ts:83` | 未修正 |

S1・S2 は保険代理店 agent network（150〜250名規模）への展開前に塞ぐべき。
S3 は金融領域の表現規制を踏まえると展開規模に比例してリスクが増大する。

### [要判断・2026-08-12] AI診断機能が未実装（判定 C）。 詳細は「既存の AI診断ロジック」節。
  - SPEC.md の前提（「現在ルールベースで実装済み」「ルールベースを捨てない」）が成立しない。
    SPEC.md の修正方針について人の承認が必要。
  - 13問の設問・12カテゴリ・分岐規則・各カテゴリのベース文面を**誰がどう決めるか**が未定。
    これは仕様判断のため CC が独断で決めない。
