# osarAI — 詳細設計書 兼 Claude Code マスタープロンプト

> このファイルをリポジトリ直下に `CLAUDE.md` として配置し、Claude Codeに「このマスタープロンプトに従ってMVPを立ち上げて」と指示する。
> 上位の要件は `requirements_mvp.md` を正本として参照すること。

---

## 0. Claude Codeへの実行指示

あなたはこのプロジェクトのリード実装者です。以下を厳守して進めてください。

1. **§14の実装順（フェーズ）に厳密に従う**。フェーズを飛ばさない。
2. 各フェーズは **feature ブランチ**で実装 → 動作確認 → コミット → 次へ。1フェーズ＝1まとまりのコミット。
3. DBスキーマ変更は必ず **Supabase migration ファイル**として `supabase/migrations/` に追加（直接いじらない）。
4. 不明点・設計の選択が必要な箇所は、**勝手に拡張せず**、まずこのドキュメントと `requirements_mvp.md` を確認。それでも不明なら質問する。
5. **MVPスコープ（§2）の範囲外を実装しない**。Phase2機能（マッチング/フル音声/Zoom連携/ネイティブ録音）は作らない。
6. 秘匿情報は `.env`（§13）。コードにハードコードしない。
7. 各フェーズ完了時に §16 のDoDを自己チェック。

---

## 1. プロダクト概要・思想

**プロダクト名**：osarAI 〜おさらい〜
**タグライン**：「忙しくても、人を大切にできる自分に。」

**思想**：営業成果とは「どれだけ人に喜ばれ、役に立てたか」の積み重ね。数字は"結果"であって"目的"ではない。大事なのは、お客さんと話したことを覚え、後日ちゃんと連絡し、望まれている人を繋ぐこと。それを忙しさで諦めないために、**人と会ったあと5分の「AI対話おさらい」習慣**で支える。"ゴリゴリ営業ツール"ではなく、誠実に人と向き合いたい人のための「記憶と気配り」の外部装置。

**ターゲット**：toC商材を扱う個人事業主（営業／対面サービス業）。MVPは株式会社LiberalLIFE（LL）の約250代理店が初期ユーザー。
**所有**：osarAIは運営者の独立プロダクト。LLは販路の1つ。データ・IP・ネットワークは運営者帰属。

---

## 2. MVPスコープ

### IN（このMVPで作る）
- **AI対話おさらい入力（メイン）**：人と会ったあと、AIが対話形式でヒアリング→顧客カードを自動整理
- 録音・録画の取り込み（サブ／録れた時だけ）→ 文字起こし→AI解析
- 顧客管理（カード＋タイムライン）
- AI戦略相談チャット（全体／顧客指定）
- リーダー集約ビュー（Web）
- 認証・組織（マルチテナント）・課金（Stripe・14日トライアル・Web完結）
- プッシュ通知（おさらいを促す＝習慣化の中核）

### OUT（Phase2以降・作らない）
- 人脈マッチング／組織横断マッチング／紹介フィー
- フル音声対話（ハンズフリー）
- 録音取得の自動化（ネイティブ長時間録音／Zoom bot連携）
- LLの15事業クロスセル連携
- アプリ内課金（IAP）

---

## 3. アーキテクチャ

```
┌──────────────────────┐      ┌──────────────────────┐
│  Mobile App           │      │  Web                  │
│  React (Vite)         │      │  Next.js (App Router) │
│  + Capacitor          │      │  - LP                 │
│  - おさらい対話        │      │  - サインアップ/課金   │
│  - 顧客カード/タイムライン│      │  - リーダーDashboard   │
│  - AI相談チャット       │      │                       │
│  push: FCM/APNs        │      │  Stripe Checkout      │
└──────────┬───────────┘      └──────────┬───────────┘
           │                              │
           └──────────────┬───────────────┘
                          │
              ┌───────────▼────────────┐
              │  Supabase                │
              │  Postgres + Auth + RLS   │
              │  + Storage(音声)          │
              └───────────┬────────────┘
                          │
          ┌───────────────┼────────────────┐
          │               │                │
     ┌────▼────┐    ┌─────▼─────┐   ┌──────▼──────┐
     │ Gemini   │    │ Stripe     │   │ FCM / APNs   │
     │ (対話/   │    │ (課金/      │   │ (push)       │
     │ 文字起こし)│    │ webhook)   │   │              │
     └─────────┘    └───────────┘   └─────────────┘
```

---

## 4. リポジトリ構成（モノレポ）

```
osarai/
├── CLAUDE.md                  # このファイル
├── requirements_mvp.md        # 要件正本
├── apps/
│   ├── mobile/                # React(Vite) + Capacitor
│   │   ├── src/
│   │   │   ├── screens/       # Login, Home, Osarai, CustomerDetail, AiChat, Settings
│   │   │   ├── components/
│   │   │   ├── lib/           # supabase client, api, gemini wrappers
│   │   │   └── hooks/
│   │   ├── capacitor.config.ts
│   │   └── ...
│   └── web/                   # Next.js (App Router)
│       ├── app/
│       │   ├── (marketing)/   # LP
│       │   ├── signup/        # サインアップ + Stripe Checkout
│       │   ├── dashboard/     # リーダー集約ビュー
│       │   └── api/           # stripe webhook, ai endpoints
│       └── ...
├── packages/
│   └── shared/                # 型定義・Supabase型・共通ロジック・AIプロンプト
├── supabase/
│   ├── migrations/            # DDL + RLS
│   └── functions/             # Edge Functions（AI処理・文字起こし）必要に応じて
└── .env.example
```

> AI処理（Gemini呼び出し）と文字起こしは、APIキー秘匿のため**サーバー側**（Next.js Route Handlers か Supabase Edge Functions）に置く。モバイルから直接Geminiを叩かない。

---

## 5. 技術スタック

| 層 | 採用 |
|----|------|
| モバイル | React (Vite) + Capacitor（iOS/Android） |
| Web | Next.js（App Router / SSR） |
| DB/認証/ストレージ | Supabase（Postgres + Auth + Storage + RLS） |
| AI（対話・文字起こし・解析） | Gemini（Flash-Lite基準、質が要る対話はFlash） |
| 課金 | Stripe（サブスク・Web完結・Apple Pay/Google Pay・14日トライアル） |
| プッシュ | FCM / APNs（Capacitor経由） |
| ホスティング | Vercel（Web/API） |
| 言語 | TypeScript（全体） |

---

## 6. データモデル（DDL）

`supabase/migrations/0001_init.sql` として作成。

```sql
-- ========== 拡張 ==========
create extension if not exists "pgcrypto";

-- ========== 組織（テナント） ==========
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ========== プロフィール（auth.users と 1:1） ==========
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  org_id        uuid not null references organizations(id),
  role          text not null default 'member' check (role in ('member','leader')),
  display_name  text,
  industry      text,                          -- 業種（将来の着せ替え用）。例: sales/beauty/trainer
  created_at    timestamptz not null default now()
);
create index on profiles(org_id);

-- ========== 顧客 ==========
create table customers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  owner_id      uuid not null references profiles(id),
  name          text not null,
  status        text not null default 'active', -- active/archived
  temperature   text check (temperature in ('hot','warm','cold')),
  needs         text,
  custom_fields jsonb not null default '{}',    -- 業種別追加項目の着せ替え
  last_met_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on customers(org_id);
create index on customers(owner_id);

-- ========== 対応履歴（入口は複数・処理は共通） ==========
create table interactions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  customer_id uuid not null references customers(id) on delete cascade,
  author_id   uuid not null references profiles(id),
  source      text not null check (source in ('ai_dialogue','in_person_rec','zoom_rec','manual')),
  type        text not null check (type in ('audio','text')),
  raw_text    text,
  audio_url   text,
  transcript  text,
  ai_summary  jsonb,                            -- {points:[], needs:[], next_actions:[]}
  met_at      timestamptz,
  created_at  timestamptz not null default now()
);
create index on interactions(customer_id);
create index on interactions(org_id);

-- ========== おさらいセッション（AI対話ログ） ==========
create table osarai_sessions (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  user_id                 uuid not null references profiles(id),
  customer_id             uuid references customers(id),
  messages                jsonb not null default '[]', -- [{role, content}]
  status                  text not null default 'in_progress' check (status in ('in_progress','done')),
  resulting_interaction_id uuid references interactions(id),
  created_at              timestamptz not null default now()
);
create index on osarai_sessions(user_id);

-- ========== AI戦略相談 ==========
create table ai_chats (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  user_id     uuid not null references profiles(id),
  scope       text not null check (scope in ('all','customer')),
  customer_id uuid references customers(id),
  title       text,
  created_at  timestamptz not null default now()
);
create table ai_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references ai_chats(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index on ai_chat_messages(chat_id);

-- ========== 課金（Stripe） ==========
create table subscriptions (
  user_id              uuid primary key references profiles(id) on delete cascade,
  stripe_customer_id   text,
  stripe_subscription_id text,
  plan                 text check (plan in ('light','standard','pro')),
  status               text,            -- trialing/active/past_due/canceled...
  promo_code           text,            -- 適用チャネル割引コード（流入トラッキング）
  trial_end            timestamptz,
  current_period_end   timestamptz,
  updated_at           timestamptz not null default now()
);

-- ========== プッシュトークン ==========
create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  token       text not null,
  platform    text not null check (platform in ('ios','android')),
  created_at  timestamptz not null default now(),
  unique(user_id, token)
);
```

---

## 7. RLSポリシー

`supabase/migrations/0002_rls.sql`。**全テーブルでRLS有効化**。テナント分離が最優先。

```sql
-- 現在ユーザーの org_id / role を引くヘルパ
create or replace function current_org_id() returns uuid
language sql stable security definer as $$
  select org_id from profiles where id = auth.uid()
$$;

create or replace function current_role() returns text
language sql stable security definer as $$
  select role from profiles where id = auth.uid()
$$;

-- 有効化
alter table organizations   enable row level security;
alter table profiles         enable row level security;
alter table customers        enable row level security;
alter table interactions     enable row level security;
alter table osarai_sessions  enable row level security;
alter table ai_chats         enable row level security;
alter table ai_chat_messages enable row level security;
alter table subscriptions    enable row level security;
alter table push_tokens      enable row level security;

-- organizations: 自組織のみ
create policy org_select on organizations for select
  using (id = current_org_id());

-- profiles: 同組織は参照可（リーダーが配下を見るため）、本人のみ更新
create policy profiles_select on profiles for select
  using (org_id = current_org_id());
create policy profiles_update on profiles for update
  using (id = auth.uid());

-- customers: member=自分のowner分のみ / leader=同組織すべて
create policy customers_select on customers for select
  using (
    org_id = current_org_id()
    and (current_role() = 'leader' or owner_id = auth.uid())
  );
create policy customers_cud on customers for all
  using (org_id = current_org_id() and owner_id = auth.uid())
  with check (org_id = current_org_id() and owner_id = auth.uid());

-- interactions: 同上（leaderは同組織閲覧、memberは自分の顧客分）
create policy interactions_select on interactions for select
  using (
    org_id = current_org_id()
    and (current_role() = 'leader' or author_id = auth.uid())
  );
create policy interactions_cud on interactions for all
  using (org_id = current_org_id() and author_id = auth.uid())
  with check (org_id = current_org_id() and author_id = auth.uid());

-- osarai_sessions / ai_chats: 本人のみ（leaderも他人の対話ログは見ない）
create policy osarai_own on osarai_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy aichats_own on ai_chats for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy aichatmsg_own on ai_chat_messages for all
  using (exists (select 1 from ai_chats c where c.id = chat_id and c.user_id = auth.uid()))
  with check (exists (select 1 from ai_chats c where c.id = chat_id and c.user_id = auth.uid()));

-- subscriptions / push_tokens: 本人のみ
create policy subs_own on subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_own on push_tokens for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

> 注意：`subscriptions` はStripe Webhookから service_role で更新するため、サーバー側はRLSをバイパスする。クライアントからの書き込みは禁止（読み取りのみ本人可）。

---

## 8. AI設計（Gemini）

### 8-1. おさらい対話（★コア）
サーバー側エンドポイント `POST /api/osarai/turn` で1ターンずつ処理。

- **入力**：`osarai_session_id`、ユーザー発話（テキスト or STT後テキスト）
- **コンテキスト**：①顧客カードのスキーマ（埋めたい項目）②対象顧客の既存データ（あれば）③これまでの対話履歴
- **Geminiへの指示**：
  1. ユーザー発話から顧客カード項目（points/needs/temperature/next_actions/custom_fields）を抽出
  2. まだ埋まっていない重要項目について**次の質問を1つ**生成
  3. 出力は JSON（`{extracted:{...}, next_question:string|null, done:boolean}`）。`next_question=null & done=true`で終了
- **終了時**：抽出を統合して `interactions`（source=`ai_dialogue`）を作成、`customers` を更新（last_met_at等）、`osarai_sessions.status=done`。

**システムプロンプト雛形**（`packages/shared/prompts/osarai.ts`）：
```
あなたは「おさらい」のAIインタビュアー。ユーザーが人と会ったあと、
記憶が新しいうちに会話で振り返りを促し、顧客情報を整理する。
- フォームを埋めさせない。1問ずつ、自然に、短く聞く。
- 既存データがあれば差分・進展を聞く（同じことを聞かない）。
- ユーザーの発話から下記スキーマを抽出: {points, needs, temperature, next_actions, custom_fields}
- 重要項目が埋まったら done=true。
- 出力は必ずJSONのみ。
顧客スキーマ: <schema>
既存データ: <customer_json or なし>
対話履歴: <history>
```

### 8-2. 文字起こし（録音サブ経路）
`POST /api/transcribe`：音声ファイル(Storage)→Gemini（長尺はチャンク分割・非同期）→`transcript`→要約(ai_summary)→`interactions`(source=録音種別)。

### 8-3. AI戦略相談
`POST /api/advice`：`scope=all`なら全顧客サマリ、`scope=customer`なら対象顧客の履歴をコンテキスト化→Gemini→回答。データが薄い初期は汎用営業ナレッジで補う（コールドスタート対策）。

> モデル選定：抽出・要約・相談はFlash-Lite（コスト¥）。対話の質が要る所だけFlash。context cachingでプロンプト再利用分を削減。

---

## 9. 機能別実装方針（F-01〜F-06）

- **F-01 顧客管理**：CRUD＋詳細（カード＋タイムライン＝interactions時系列）。一覧はstatus/temperatureで絞り込み。
- **F-02 AI対話おさらい（メイン）**：§8-1。Home→「おさらいする」→対話画面→サマリ確認→保存。
- **F-03 録音取り込み（サブ）**：音声をStorageにアップ→§8-2。録れた時だけの任意導線。
- **F-04 AI相談**：§8-3。scope切替（全体/顧客指定）。
- **F-05 リーダー集約ビュー（Web）**：leaderが同組織のメンバー一覧＋主要指標（顧客数/活動量）→ドリルダウン。閲覧のみ。
- **F-06 認証・組織・課金**：§11。

---

## 10. 画面一覧

**モバイル（React/Capacitor）**
- Login（Supabase Auth）
- Home（今日のおさらい促し＋顧客リスト）
- Osarai（AI対話おさらい：チャット＋音声入力）
- CustomerDetail（カード＋タイムライン）
- AiChat（戦略相談：scope切替）
- Settings（プロフィール／通知許可。※課金導線は置かない）

**Web（Next.js）**
- LP（既存 `osarai_lp.html` のデザインを踏襲）
- Signup（メール登録 → Stripe Checkout：14日トライアル／Apple Pay）
- Login
- Dashboard（リーダー集約ビュー）

---

## 11. 課金フロー（Stripe・3層プラン・IAP回避）

**プラン（Good-Better-Best）**：Stripeに3つのPriceを作成。

| プラン | 定価/月 | 主な差別化（fence） |
|---|---|---|
| Light | ¥1,980 | おさらい＋顧客管理。AI相談は月10回まで。録音取り込み不可 |
| **Standard（本命）** | **¥3,980** | AI相談無制限＋録音取り込み |
| Pro | ¥6,980 | ＋リーダー集約＋Phase2マッチング優先解放 |

- モデル：**14日カード先取りトライアル**（`trial_period_days: 14`）。登録時に決済情報→14日無料→自動課金。
- 決済：**Stripe Checkout（subscription）**、**Apple Pay/Google Pay有効化**（ワンタップ＋手数料3%台）。
- **チャネル割引（額引きプロモコード方式）**：定価は下げない。Stripe Coupon（`amount_off`）＋Promotion Codeでチャネル別割引。割引後も末尾980で揃える。
  - **LL福利厚生価格**：Light¥1,480（¥500off）／Standard¥2,980（¥1,000off）／Pro¥4,980（¥2,000off）。一般提携は割引額を浅く。
  - プランごとに別Coupon（¥500/¥1,000/¥2,000の `amount_off`）。`duration: forever`（入口だけ深くするなら `repeating`）。
  - チャネル専用の登録リンクにコードを埋めて配布（ユーザーは入力不要）。コード単位で流入トラッキング。
- **アプリ内には課金・価格・外部決済への導線を一切置かない**（IAP回避・ストア審査対策）。課金は完全にWeb。
- **プライスラダー**：将来の値上げ時、既存ユーザーは旧Priceに据え置き（Stripeはsubscription単位でPrice固定なので自然にロックされる）。
- Webhook `/api/stripe/webhook`：`customer.subscription.*` / `checkout.session.completed` を受けて `subscriptions` を service_role で更新（plan・status・trial_end・割引コード）。
- アプリ起動時に `subscriptions.status` と `plan` を確認し、未契約/解約は機能制限、planに応じて機能ゲート（AI相談回数・録音・リーダー集約）。
- 導線：LL案内（割引コード入りリンク）→ Web Signup → Stripe Checkout（トライアル開始）→ アプリDL＆ログイン → 14日後に自動課金。

---

## 12. プッシュ通知（習慣化の中核）

- Capacitor Push Notifications（FCM/APNs）。起動時にトークン取得→`push_tokens` 保存。
- **おさらい促し**：ユーザーが予定/活動を入れたら、その後（or 1日の終わり）に「今日会った人、おさらいする？」を送る。能動入力→受動回答に変えるのが目的。
- 到達率が肝なのでネイティブプッシュ前提（PWAプッシュは使わない）。

---

## 13. 環境変数（`.env.example`）

```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # サーバーのみ
# Gemini
GEMINI_API_KEY=                   # サーバーのみ
# Stripe
STRIPE_SECRET_KEY=                # サーバーのみ
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_LIGHT=               # Light ¥1,980
STRIPE_PRICE_STANDARD=           # Standard ¥3,980
STRIPE_PRICE_PRO=                # Pro ¥6,980
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
# Push
FCM_SERVER_KEY=
APNS_*=
```

---

## フェーズ0：環境セットアップ（着手前）

### A. 自分でやる（5分・機密キーはエージェントに渡さない）
- [ ] **Supabase**：新規プロジェクト作成 → `SUPABASE_URL` / `anon` / `service_role` と PROJECT_REF を控える
- [ ] **Gemini**：Google AI Studioで `GEMINI_API_KEY` 発行
- [ ] **Stripe**：アカウント作成（まずテストモード）→ `STRIPE_SECRET_KEY` / publishable key を控える
- [ ] **GitHub**：リポジトリ作成、`CLAUDE.md`（本書）と `requirements_mvp.md` を配置
- [ ] 控えたキーを `.env`（§13）に記入

### B. Claude Codeにやらせる（スクリプト化）

**B-1. Stripe（CLI）— Price 3つ・Coupon 3つ・LL用Promotion Code**
```bash
# 前提: stripe login 済み（テストモード）。JPYはzero-decimal＝金額は円そのまま
LIGHT=$(stripe products create --name="osarAI Light"    | grep -o 'prod_[A-Za-z0-9]*' | head -1)
STD=$(stripe products create   --name="osarAI Standard" | grep -o 'prod_[A-Za-z0-9]*' | head -1)
PRO=$(stripe products create   --name="osarAI Pro"      | grep -o 'prod_[A-Za-z0-9]*' | head -1)

stripe prices create --product=$LIGHT --unit-amount=1980 --currency=jpy -d "recurring[interval]=month"
stripe prices create --product=$STD   --unit-amount=3980 --currency=jpy -d "recurring[interval]=month"
stripe prices create --product=$PRO   --unit-amount=6980 --currency=jpy -d "recurring[interval]=month"

# チャネル割引（額引き・恒常）
stripe coupons create --amount-off=500  --currency=jpy --duration=forever --name="LL Light"
stripe coupons create --amount-off=1000 --currency=jpy --duration=forever --name="LL Standard"
stripe coupons create --amount-off=2000 --currency=jpy --duration=forever --name="LL Pro"

# LLチャネル用 Promotion Code（上で作ったStandard CouponのIDを使う）
stripe promotion_codes create --coupon=<COUPON_STANDARD_ID> --code=LL2026
```
- 出力された `price_xxx` を `.env` の `STRIPE_PRICE_LIGHT/STANDARD/PRO` に転記。
- **14日トライアルはPriceではなくCheckout作成時**に `trial_period_days: 14` で指定（§11）。

**B-2. Supabase（CLI）— DB構築**
```bash
supabase init
supabase link --project-ref <PROJECT_REF>
# §6 DDL → supabase/migrations/0001_init.sql
# §7 RLS → supabase/migrations/0002_rls.sql
supabase db push
supabase gen types typescript --linked > packages/shared/database.types.ts
```

**B-3. Stripe Webhook（ローカル開発）**
```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# 表示される whsec_xxx を STRIPE_WEBHOOK_SECRET に記入
```

> 機密の鉄則：`service_role` / `STRIPE_SECRET_KEY` は人間が手でコピーして`.env`へ。ブラウザエージェントに画面で扱わせない。FCM/APNsとストア登録はプッシュ／提出フェーズで。

完了したら → フェーズ1へ。

---

## 14. 実装順（フェーズ1〜）

1. **Scaffold**：モノレポ作成（apps/mobile=Vite+React+Capacitor、apps/web=Next.js、packages/shared、supabase/）。`.env.example`。
2. **DB**：§6 DDL → §7 RLS を migration として適用。Supabase型を `packages/shared` に生成。
3. **Auth**：Supabase Auth（メール）。サインアップで `organizations`/`profiles` 作成（初期は1組織=LL、roleは招待/設定で付与）。
4. **課金（Web）**：Signup → Stripe Checkout（14日trial, Apple Pay）→ webhook → `subscriptions`。
5. **顧客管理（Mobile）**：ログイン → 顧客CRUD → CustomerDetail（カード＋タイムライン）。
6. **おさらい対話（Mobile＋API）★コア**：§8-1。対話→サマリ→interaction/customer反映。音声入力（サーバーSTT）も。
7. **AI相談（Mobile＋API）**：§8-3。
8. **録音取り込み（サブ）**：§8-2。
9. **リーダーDashboard（Web）**：§F-05。
10. **プッシュ通知**：§12。
11. **仕上げ＆DoD**：§16チェック、ストア提出準備（課金導線がアプリ内に無いこと確認）。

---

## 15. Claude Code 運用ルール

- 1フェーズ＝1 feature ブランチ → 動作確認 → コミット（例 `feat: phase6 osarai dialogue`）。
- DBは必ず migration 追加（既存migrationを書き換えない）。
- サーバー秘匿キー（service_role/Gemini/Stripe）は**サーバー側のみ**。クライアントに出さない。
- 型は `packages/shared` に集約し、mobile/web で共有。
- 各フェーズ完了でこのドキュメントのDoDを自己チェックし、要約を残す。
- スコープ外（§2 OUT）は実装しない。やりたくなったら止めて確認。

---

## 16. MVP完了の定義（DoD）

- [ ] 全テーブルでRLS有効、他組織データに一切アクセスできない（テナント分離テスト済み）
- [ ] Web Signup → 14日トライアル開始 → 14日後 自動課金 が動く（Apple Pay含む）
- [ ] アプリ内に課金・価格導線が一切ない（ストア審査対策）
- [ ] 人と会ったあと、AI対話おさらい5分で顧客カードが自動整理される（§8-1が一周回る）
- [ ] 録音取り込み→文字起こし→顧客カード反映 が動く（サブ経路）
- [ ] AI相談（全体/顧客指定）が顧客データを踏まえて回答する
- [ ] リーダーがWebで配下メンバーの集約を閲覧できる（閲覧のみ）
- [ ] プッシュ通知でおさらいを促せる（実機で到達確認）
- [ ] 未契約/解約ユーザーは機能制限される
- [ ] 顧客カードは業種非依存スキーマ＋custom_fieldsで、業種着せ替えの余地がある

---

## Pipeline設定（/run 自走ループ harness 用・2026-06-29 移植時点の実値）

`.claude/commands/run.md`（/run）の `{{...}}` プレースホルダはここと `.env` から解決する。
§0 自己点検で確認した osarAI の実構成：

| キー | 実値 | 備考 |
|---|---|---|
| **APP_LAYOUT** | pnpm monorepo | `apps/web`(Next.js・port3000) / `apps/mobile`(Vite+Capacitor) / `packages/shared` |
| **TYPECHECK** | `pnpm -r typecheck` | 各appは `tsc --noEmit`（web/mobile とも） |
| **BUILD** | `pnpm -r build` | web=`next build` / mobile=`tsc -b && vite build` |
| **TEST** | none | テストscriptは未定義（root/apps とも `test*` 無し）→ テスト段はスキップ |
| **PLAYWRIGHT_PROJECTS** | none | `playwright.config.*` 無し → E2E段はスキップ（全spec も無し） |
| **LOCAL_STACK** | supabase | `supabase/`（config.toml: API 54321 / DB 54322 / Studio 54323）。`supabase start` で起動 |
| **MIGRATIONS_DIR** | `supabase/migrations` | 0001_init / 0002_rls / 0003_auth_seed。RLSは org_id + owner_id(auth.uid()) スコープ |
| **DEPLOY_PLATFORM** | ⚠️未確定 | `vercel.json` 等のデプロイ設定ファイル無し → **要確認**（web は Vercel 想定だが未確認） |
| **DEV_URL** | `http://localhost:3000` | apps/web の `next dev -p 3000`（.env にも記載） |
| **PROD_BRANCH** | `main`（確定） | 2026-06-29 phase5-customers HEAD を `main` に昇格し origin へ push。`dev` も `main` から分岐して push 済。通常feature=dev基点／緊急=main派生hotfix。`.env` PROD_BRANCH=main 同期済 |

### マルチテナント / RLS（rls-multitenant ルールの adapt 先）
- テナント = `org_id`（profiles.org_id = current_org_id()）、所有者 = `owner_id`/`author_id`/`user_id` = `auth.uid()`。
- 全テーブルで RLS 有効（Supabase Auth 前提）。sido のような anon 公開キー直叩きモデルは無い（＝anon-access は Stripe webhook / 公開リンク等に限定）。

### /run harness の前提（移植メモ）
- `.env` に `NOTION_TOKEN`（共有バックログ統合・sido と同一）, `BACKLOG_PROJECT_ID`(=osarAI), `BACKLOG_DS_ID`/`BACKLOG_DATA_SOURCE_ID`, `AUTO_MERGE_TARGET=dev`, `AUTO_TIER=低`, `MAX_WALL=180`, `GEMINI_REVIEW_API_KEY`/`GEMINI_REVIEW_MODEL` を設定済。
- **設定済（2026-06-29 解消）**: `HUMANBALL_WEBHOOK_URL`/`HUMANBALL_WEBHOOK_SECRET`（sido と同一LINE通知先を流用＝A案。`notify-humanball.mjs` は本文 task に `[osarAI]` 接頭辞を付与し混線回避）／`main`・`dev` ブランチ（origin へ push 済）。
- **未設定（実 /run には後日でOK・要確認）**: `SUPABASE_PROD_DB_URL`（rls-audit の本番監査・local監査/dry-runには不要）, `DEPLOY_PLATFORM`（web のデプロイ基盤未確認）, E2E/Playwright（テスト導入時に PLAYWRIGHT_PROJECTS 更新）。
- `scripts/`: dispatcher / notify-humanball / independent-review / rls-audit / next-target（+ `.kody/rules`・`.kody/accepted.yml` は osarAI ドメインへ書換済）。
- **コマンド**: `.claude/commands/run.md`（/run・自走ループ）／`.claude/commands/review.md`（/review・レビュー待ち→本番待ちの人力ナビ）。**/review は web中心**＝apps/web/mobile は原則ブラウザ（{{DEV_URL}}）で確認し、ネイティブ依存（プッシュ実機体裁・カメラ・APNS/FCM・課金実機）は `⚠実機確認` 扱いで初回リリース基盤確立後に実機ナビを足す。status更新は REST PATCH（Notion-Version 2025-09-03）。
