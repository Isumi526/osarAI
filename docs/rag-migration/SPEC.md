# osarAI AI診断機能 RAG移行プロジェクト 仕様書

> 本ファイルはプロジェクト仕様の正本。セッションのコンテキストが失われても、
> このファイルを読めばプロジェクトの全体像が分かる状態を保つこと。
> 進捗は `PROGRESS.md`、判断の記録は `DECISIONS.md` を参照。

---

## 0. 背景と目的

### 0.1 現状

> ⚠️ **2026-08-13 改訂。** 初版はここに「AI 診断機能は 13問・12カテゴリ分岐のルールベース出力で
> 実装済み」と記していたが、リポジトリ横断調査の結果、**そのような実装は存在しない**ことが判明した
> （調査の全記録は `PROGRESS.md`「既存の AI診断ロジック」節）。前提が誤っていたため本節を書き直す。

**AI 診断機能は未実装。** 13問の設問セットも 12カテゴリの分岐ロジックも、
全ローカルブランチ・全コミット・作業ツリーのいずれにも存在しない。
「13問・12カテゴリ」は構想段階のメモであって確定仕様ではなかった。

一方、既存の AI 機能（おさらい対話・自分をおさらい・AI戦略相談・顧客登録AI解析・アポ戦略cron）は
**すべて LLM の自由生成**であり、設問形式でも分岐でもない。
そして**出典グラウンディング・ガードレール・免責表示のいずれも実装されていない**。
唯一のルールベース分岐は `computeAutoTemperature()`（hot/warm/cold の3分岐）で、
これは顧客の温度感ラベル用であり診断ではない。

したがって本プロジェクトは「ルールベース → RAG への**移行**」ではなく、
**「AI診断機能の新規構築（ルールベースの骨格 + RAG による肉付け）」**である。

### 0.2 このプロジェクトで解決する課題

| 課題 | 現状 | 移行後 |
|---|---|---|
| 診断結果の具体性 | 該当機能なし（診断は未実装） | 顧客の回答内容に応じた個別の示唆 |
| 出力の根拠 | なし（既存AI機能はすべて出典なしの自由生成） | 出典ドキュメントを明示 |
| 法務リスク | **未管理**（禁止表現チェック・出典・免責のいずれも無し） | 出典グラウンディング + ガードレール併用で管理 |
| 改善サイクル | プロンプトをコードで直す | ナレッジを追加すれば出力が改善 |

**プロジェクトの位置づけ：これは「リスクを取る変更」ではなく「今あるリスクを管理下に置く変更」である。**
初版は「現状はルールベースで法務リスクを回避できている。RAG 化はそこに新たなリスクを持ち込むので
慎重に」という構図で書かれていたが、事実は逆だった。既存機能はすでに LLM が自由生成した文章を
そのままユーザーへ届けており、防御機構が無い。RAG 化に伴って設計するガードレール・出典制約・
免責表示は、**新規のリスク対策であると同時に、既存の未管理リスクに対する初めての対策**にあたる。

**重要な設計思想：ルールベースの骨格を先に作る。**
LLM に自由生成させるのではなく、まずルールベースの分岐で「安全な骨格」を確定させ、
RAG はその骨格に肉付けする役割に限定する。検索してきた出典の範囲内でのみ記述する制約をかける。
初版は「v1 のルールベースを**捨てない**」と書いていたが、その v1 が存在しないため、
**Phase 0 で骨格そのものを新規設計する**（本書 Phase 0 節）。趣旨は同じで、順序が逆になる。

### 0.3 副次目的

本プロジェクトは、以下の技術領域の実務経験を獲得することも目的に含む。

- Python / FastAPI によるバックエンド開発
- RAG の設計・実装・評価
- AWS 上でのコンテナデプロイと IaC
- PoC の評価設計（評価データ・合格基準・定量的な Go/No-Go 判断）
- **既存の LLM 自由生成機能（おさらい対話・AI戦略相談・アポ戦略cron）に対する
  出典グラウンディングとガードレールの後付け適用。本プロジェクトで得た知見をこれらへ横展開する。**

最後から2番目の項目（評価設計）が特に重要。「動くものを作った」で終わらせず、
定量指標で品質を測り、リリース可否を判断できる状態まで作ること。

最後の項目（既存機能への横展開）は 0.2 の位置づけから導かれる。
診断機能だけをガードレールで守っても、同じアプリ内の他の LLM 経路が無防備なら
プロダクト全体としてのリスクは下がらない。本プロジェクトは横展開先を持つ試験台でもある。

---

## 1. アーキテクチャ

```
osarAI Frontend (Next.js 15 / Vercel)
        │ POST /api/diagnosis
        ▼
Next.js Route Handler (BFF)
  ・Supabase Auth でユーザー検証
  ・プラン別の利用回数上限チェック
  ・FastAPI へプロキシ
        │ POST /v1/diagnose
        │ Authorization: Bearer <Supabase JWT>
        ▼
FastAPI (AWS ECS Fargate)
  ├─ POST /v1/diagnose   診断実行
  ├─ POST /v1/ingest     ドキュメント取込
  ├─ POST /v1/eval       評価バッチ実行
  └─ GET  /healthz       ヘルスチェック
        │
        ├─→ Supabase PostgreSQL + pgvector
        ├─→ LLM API（OpenAI / Gemini）
        └─→ AWS S3（原本文書）
```

### 1.1 技術選定の根拠

| 選定 | 理由 |
|---|---|
| FastAPI | 型安全（pydantic v2）、非同期対応、OpenAPI 自動生成 |
| pgvector on Supabase | 既存 Supabase をそのまま使える。運用対象を増やさない |
| ECS Fargate | Lambda はコールドスタートと 15分制限が ingest に不利 |
| S3 | 原本保管。バージョニングで再インデックス時の再現性を確保 |
| Terraform | IaC。手動構築だと再現性がない |

ベクトルストアは Supabase の pgvector を使う。
RAG のベクトルデータと業務データを同一 DB に置ける運用メリットが大きい。
AWS 経験は ECS / S3 / Terraform / CloudWatch で十分に得られる。

---

## Phase 0：診断ロジックの新規設計【2026-08-13 新設・§2 の前提工程】

> 節番号を振らずに §1 と §2 の間に置く。既存の節番号（2.1 / 2.3 / 3.2 …）を
> 他ドキュメントから参照しているため、繰り下げによる参照崩れを避ける。

### なぜ必要か

0.1 のとおり移植元が存在しないため、`diagnosis/rules.py` の中身を決める工程が
どこにも無い。これは実装ではなく**事業仕様の判断**であり、実装者が独断で決めてはならない。

さらに、これは日程の都合ではなく**依存関係の問題**である。
Phase 2 のゴールデンデータセットは `expected_category` を持つ（3.2）。
カテゴリ定義が無ければデータセットが作れず、**本プロジェクトで最重要と位置づけた
Phase 2（評価設計）が着手不能になる**。よって Phase 0 は最初に置く。

### 決めること

1. 診断カテゴリの数と定義（各カテゴリが「どういう課題の状態か」）
2. 設問（設問文と選択肢）
3. 設問 → カテゴリの分岐規則
4. 各カテゴリの「安全なベース文面」（RAG が失敗してもこれを返せば成立する最終防衛線）

### 制約と方針

- **「13問・12カテゴリ」の数字に縛られない。** 未実装の構想メモであり確定仕様ではない。
  6〜12カテゴリの範囲で、根拠とともに妥当な数を決める。
- **評価設計（Phase 2）が回る最小構成を優先する。**
  カテゴリが少ないほどゴールデンデータセットの必要件数も減り、Phase 2 に早く到達できる。
- **既存の osarAI が持っている「営業の見方」と整合させる。**
  既存機能（おさらい対話のシステムプロンプト／顧客登録AI解析の抽出項目／アポ戦略cron の判断／
  `computeAutoTemperature()` の判定基準／Supabase の顧客・商談・フォロー履歴のスキーマ）から
  診断軸を抽出し、そこから外れないようにする。整合していない診断カテゴリは
  プロダクトとして一貫しない。

### 進め方

| 手順 | 担当 | 内容 |
|---|---|---|
| 1 | 実装者 | 既存機能から診断軸を抽出し、「osarAI が既に持っている営業の見方」を言語化 |
| 2 | 実装者 | 叩き台（カテゴリ候補・設問候補・分岐規則）を根拠つきで提案 |
| 3 | **事業責任者** | 叩き台に対して判断し確定。**事業仕様の最終決定は実装者が行わない** |
| 4 | 実装者 | 確定版を `docs/rag-migration/PHASE0_DIAGNOSIS_SPEC.md` として保存 |

### 完了条件

- `PHASE0_DIAGNOSIS_SPEC.md` が存在し、カテゴリ・設問・分岐規則・ベース文面が確定している
- その内容だけを見て `diagnosis/rules.py` が実装でき、`golden_dataset.jsonl` の
  `expected_category` が書ける状態になっている

---

## 2. Phase 1：FastAPI + RAG コア

### 2.1 ディレクトリ構成

```
api-python/
├── pyproject.toml
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
├── src/
│   └── osarai_rag/
│       ├── __init__.py
│       ├── main.py                # FastAPI アプリ本体
│       ├── config.py              # pydantic-settings による設定
│       ├── deps.py                # DI（DBセッション、認証）
│       ├── auth/
│       │   ├── __init__.py
│       │   └── jwt_verifier.py    # Supabase JWT を JWKS で検証
│       ├── models/
│       │   ├── __init__.py
│       │   ├── schemas.py         # pydantic リクエスト/レスポンス
│       │   └── db.py              # SQLAlchemy 2.0 モデル
│       ├── rag/
│       │   ├── __init__.py
│       │   ├── chunker.py
│       │   ├── embedder.py
│       │   ├── retriever.py
│       │   └── generator.py
│       ├── diagnosis/
│       │   ├── __init__.py
│       │   ├── rules.py           # Phase 0 で確定した設問→カテゴリ分岐を新規実装
│       │   ├── orchestrator.py    # ルール + RAG の統合
│       │   ├── guardrails.py      # 出力検証
│       │   └── forbidden_patterns.py
│       ├── eval/
│       │   ├── __init__.py
│       │   ├── metrics.py
│       │   ├── runner.py
│       │   ├── reporter.py
│       │   └── decision.py
│       └── routers/
│           ├── __init__.py
│           ├── diagnose.py
│           ├── ingest.py
│           └── eval.py
├── migrations/
│   └── 001_create_rag_tables.sql
├── eval/
│   ├── golden_dataset.jsonl
│   └── results/
└── tests/
    ├── conftest.py
    ├── test_health.py
    ├── test_auth.py
    ├── test_chunker.py
    ├── test_retriever.py
    ├── test_guardrails.py
    └── test_diagnose_e2e.py
```

### 2.2 依存パッケージ

```toml
[project]
name = "osarai-rag"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.32",
    "pydantic>=2.9",
    "pydantic-settings>=2.6",
    "sqlalchemy[asyncio]>=2.0",
    "asyncpg>=0.30",
    "pgvector>=0.3",
    "openai>=1.54",
    "python-jose[cryptography]>=3.3",
    "httpx>=0.27",
    "tenacity>=9.0",
    "structlog>=24.4",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3",
    "pytest-asyncio>=0.24",
    "pytest-cov>=6.0",
    "ruff>=0.7",
    "mypy>=1.13",
]
```

### 2.3 DB スキーマ

```sql
create extension if not exists vector;

create table rag_documents (
  id              uuid primary key default gen_random_uuid(),
  title           text        not null,
  source_type     text        not null,  -- 'internal_playbook' | 'public_article' | 'case_study'
  source_uri      text,
  category        text        not null,  -- TODO(Phase 0): カテゴリ定義は未確定。
                                         -- PHASE0_DIAGNOSIS_SPEC.md 確定後に値の集合を定め、
                                         -- check 制約にするか参照テーブルにするかを判断する
  version         int         not null default 1,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table rag_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid        not null references rag_documents(id) on delete cascade,
  chunk_index     int         not null,
  content         text        not null,
  content_tsv     tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding       vector(1536),
  token_count     int,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index rag_chunks_embedding_idx on rag_chunks
  using hnsw (embedding vector_cosine_ops);
create index rag_chunks_tsv_idx on rag_chunks using gin (content_tsv);
create index rag_chunks_document_idx on rag_chunks (document_id);

create table diagnosis_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid        not null,
  user_id         uuid        not null,
  answers         jsonb       not null,
  rule_category   text        not null,
  retrieved_ids   uuid[]      not null,
  output          jsonb       not null,
  guardrail_flags jsonb       not null default '{}'::jsonb,
  latency_ms      int,
  input_tokens    int,
  output_tokens   int,
  model           text,
  created_at      timestamptz not null default now()
);

create index diagnosis_runs_tenant_idx on diagnosis_runs (tenant_id, created_at desc);

alter table rag_documents  enable row level security;
alter table rag_chunks     enable row level security;
alter table diagnosis_runs enable row level security;

-- ⚠️ ポリシーは既存テーブルの実装を確認してから同じ方針で書くこと
```

### 2.4 ハイブリッド検索

ベクトル検索だけにしない。
日本語の営業用語は表記ゆれが多く、
ベクトル検索単独だと固有名詞（例：「SPIN」「BANT」）の取りこぼしが起きる。

1. pgvector の cosine 距離で上位 20 件
2. PostgreSQL の ts_rank で上位 20 件
3. **RRF（Reciprocal Rank Fusion）** で統合 → 上位 5 件
4. ルールベースが判定したカテゴリでフィルタ

RRF を採用する理由：スコアのスケールが異なる 2 つの検索結果を、
正規化なしで統合できる。順位だけを使うため実装が単純で、チューニング項目が少ない。

### 2.5 生成（出典制約）

```
あなたは営業活動の改善を支援するアシスタントです。

## 絶対的な制約

1. 提供された【参考資料】に書かれている内容のみを根拠にしてください。
2. 参考資料に記載のない情報を推測・補完してはいけません。
3. 各示唆には必ず [1] [2] のような出典番号を付けてください。
4. 参考資料から十分な根拠が得られない項目は、無理に書かず省略してください。

## 禁止事項

- 売上や成約率の向上を数値で約束する表現
- 「必ず」「確実に」「保証します」といった断定的な効果の表現
- 特定の個人・企業を評価・断定する表現
- 医療・法律・税務・投資に関する助言

## 出力形式

JSON のみを出力してください。前置き・後置きは不要です。

{
  "summary": "現状の要約（100字以内）",
  "insights": [
    {"title": "...", "detail": "...", "citations": [1, 2]}
  ],
  "next_actions": [
    {"action": "...", "why": "...", "citations": [1]}
  ]
}
```

設計意図：

- 出典番号を必須にすることで、後段のガードレールで「引用のない主張」を機械的に検出できる
- 「根拠がなければ省略してよい」と明示し、ハルシネーションの動機を下げる
- 禁止事項は v1 でルールベースを選んだ理由（法務リスク）に直接対応させる

### 2.6 ガードレール（出力検証）

生成後、必ず以下を機械的に検証する。失敗したらルールベース出力にフォールバック。

| # | 検証項目 | 判定方法 | 失敗時 |
|---|---|---|---|
| G1 | JSON としてパースできるか | `json.loads` | フォールバック |
| G2 | スキーマに適合するか | pydantic バリデーション | フォールバック |
| G3 | 全ての insight に citations があるか | 配列長 > 0 | 該当項目を除外 |
| G4 | citations が実在する番号か | 検索結果の範囲内か | 該当項目を除外 |
| G5 | 禁止表現が含まれないか | 正規表現リスト | フォールバック |
| G6 | 出力長が上限内か | 文字数チェック | 切り詰め |

```python
FORBIDDEN_PATTERNS = [
    r"必ず.{0,10}(向上|改善|成功|増加)",
    r"(確実に|絶対に).{0,10}(達成|実現)",
    r"保証(します|いたします|する)",
    r"\d+\s*[%％].{0,10}(向上|アップ|改善)(します|する)",
    r"(法的に|税務上).{0,5}(問題ありません|適法です)",
]
```

⚠️ フォールバック時もユーザーには診断結果を返す。エラー画面にしない。
ただし `diagnosis_runs.guardrail_flags` に記録し、後で分析できるようにする。

### 2.7 認証

Supabase JWT を FastAPI 側で検証する。

- Supabase の JWKS エンドポイントから公開鍵を取得（TTL付きキャッシュ）
- python-jose で署名検証
- `aud` / `iss` / `exp` を検証
- claims から `tenant_id` / `user_id` / `role` を取り出す

⚠️ **Service Role キーを FastAPI に持たせない。**
秘密情報は全て環境変数（本番は AWS Secrets Manager）。
`.env.example` にはキー名のみ記載し、値は空にする。

### 2.8 Phase 1 完了条件

- `docker compose up` でローカル起動し、`/healthz` が 200
- `POST /v1/ingest` でチャンク化・埋め込み生成ができる
- `POST /v1/diagnose` で出典付き JSON が返る
- 認証なしのリクエストが 401
- ガードレール G1〜G6 の単体テストが通る
- LLM API 停止時もルールベース出力が返る
- ruff / mypy エラーゼロ、カバレッジ 70% 以上

---

## 3. Phase 2：評価設計と Next.js 統合

### 3.1 なぜ評価設計が重要か

「RAG を作りました」は誰でも言える。差がつくのは
**「品質を定量的に測り、リリース可否を判断できるか」**。

### 3.2 ゴールデンデータセット

`eval/golden_dataset.jsonl`。最低 30 件、できれば 50 件。

```jsonl
{"id": "g001", "answers": {}, "expected_category": "リード獲得", "must_cite_doc_ids": ["doc-uuid-1"], "must_not_contain": ["必ず成約"], "note": "初回商談が少ないパターン"}
```

作り方：

> ⚠️ 件数は Phase 0 で確定するカテゴリ数に依存する。下記の「12カテゴリ」は初版の想定値であり、
> Phase 0 でカテゴリ数が確定したら「確定カテゴリ数 × 各 3〜4 パターン」に読み替える。

1. 12カテゴリ × 各 3〜4 パターンで回答セットを作る
2. 各パターンについて「この出典が引かれるべき」を人手で決める
3. 曖昧なケース（複数カテゴリに該当しうる）を意図的に混ぜる

### 3.3 評価指標と合格基準

| レイヤ | 指標 | 定義 | 合格基準 |
|---|---|---|---|
| 検索 | Recall@5 | 期待出典が上位5件に含まれる割合 | ≥ 0.85 |
| 検索 | MRR | 期待出典の順位の逆数の平均 | ≥ 0.70 |
| 生成 | 出典遵守率 | citations が実在し、内容が出典に含まれる割合 | ≥ 0.95 |
| 生成 | 禁止表現混入率 | must_not_contain に抵触した割合 | = 0.00 |
| 生成 | カテゴリ一致率 | ルール判定と生成内容の整合 | ≥ 0.90 |
| 運用 | p95 レイテンシ | 診断1件あたりの応答時間 | ≤ 8秒 |
| 運用 | フォールバック率 | ガードレール失敗率 | ≤ 5% |
| 運用 | 1件あたりコスト | Embedding + 生成の API 料金 | ≤ 15円 |

### 3.4 Go / No-Go 判断基準

```
GO 条件（全て満たすこと）:
  ✓ Recall@5      ≥ 0.85
  ✓ 出典遵守率     ≥ 0.95
  ✓ 禁止表現混入率  = 0.00      ← 1件でも出たら NO-GO
  ✓ p95 レイテンシ ≤ 8秒
  ✓ 1件あたりコスト ≤ 15円

NO-GO の場合の対応:
  Recall 不足     → チャンクサイズ / RRF の重み / ナレッジ追加
  出典遵守率不足   → プロンプト強化 / ガードレール G4 の厳格化
  禁止表現混入     → 正規表現の追加 + プロンプトの禁止事項を具体化
  レイテンシ超過   → 検索件数削減 / モデル変更 / キャッシュ導入
  コスト超過      → Embedding モデル変更 / チャンク数削減
```

⚠️ 禁止表現混入率だけは 0 を要求する。
法務リスクに直結するため、1件でも出たら原因を潰してから再評価する。

### 3.5 Next.js 側の統合

- `app/api/diagnosis/route.ts` で認証・課金プラン判定・レート制限
- ⚠️ 利用回数制限は **UTC 基準 + DB のアトミックな更新**で実装
  （過去に「タイムゾーン & 競合」の脆弱性を検出しているため）
- タイムアウト 15秒、失敗時はルールベース結果を返す
- UI に出典表示（タイトル + 該当箇所）
- ディスクレーマー：「本診断は一般的な情報提供であり、特定の成果を保証するものではありません」
- フォールバック時は通常と区別できる表記にする

### 3.6 Phase 2 完了条件

- ゴールデンデータセット 30件以上
- `python -m osarai_rag.eval` が動作し、全指標が算出される
- Go/No-Go 判定が自動で出る
- GitHub Actions で PR ごとに評価が走る
- Next.js 側から診断が実行でき、出典が UI に表示される
- FastAPI 停止時もルールベース結果が返る
- `eval/results/report.md` で数値による Go/No-Go 判断ができる

---

## 4. Phase 3：AWS デプロイと IaC

### 4.1 構成

```
terraform/
├── main.tf
├── variables.tf
├── outputs.tf
├── modules/
│   ├── ecr/
│   ├── ecs/
│   ├── alb/
│   ├── s3/
│   ├── secrets/
│   └── observability/
└── envs/
    ├── stg/
    └── prod/
```

⚠️ dev / stg / prod を必ず分離する。

### 4.2 CI/CD

```
PR 時:
  - ruff check
  - mypy
  - pytest --cov
  - eval（Go/No-Go を PR にコメント）

main への push 時:
  - docker build & push to ECR
  - terraform plan（差分を PR にコメント）
  - terraform apply（手動承認後）
  - ECS サービス更新
  - スモークテスト（/healthz + 診断1件）
```

### 4.3 監視

| 対象 | メトリクス | アラート条件 |
|---|---|---|
| API | エラー率 | 5分間で 5% 超 |
| API | p95 レイテンシ | 10秒超が 3回連続 |
| RAG | フォールバック率 | 1時間で 10% 超 |
| RAG | 禁止表現検出 | 1件でも発生したら即通知 |
| コスト | LLM API 利用額 | 日次予算の 80% 到達 |

### 4.4 Phase 3 完了条件

- `terraform apply` で stg 環境が構築できる
- ECR プッシュから ECS デプロイまで CI で自動化
- CloudWatch でログとメトリクスが確認できる
- アラートが通知される
- Secrets Manager から秘密情報が読める
- README で第三者が再現できる

---

## 5. スコープ外（今回やらないこと）

- リランカーモデルの導入
- 複数 LLM の切り替え機構
- ストリーミング応答
- 管理画面からのナレッジ編集 UI
- 多言語対応

---

## 6. 詰まったときの判断基準

| 状況 | 判断 |
|---|---|
| 検索精度が上がらない | ナレッジの量・質を疑う。アルゴリズムより先にデータ |
| レイテンシが遅い | 検索件数を減らす → モデルを軽くする → キャッシュ、の順 |
| コストが高い | Embedding は一度きり。生成側のトークン数を削る |
| 完璧を求めたくなる | 評価指標の合格基準を満たしたら次へ進む |
| 既存実装と方針が食い違う | 勝手に決めず、必ず確認する |

---

## 7. スケジュール目安

| 週 | 内容 | 成果物 |
|---|---|---|
| 0 | **Phase 0（新設）** | `PHASE0_DIAGNOSIS_SPEC.md`（カテゴリ・設問・分岐規則の確定） |
| 1 | Phase 1 | ローカルで診断が動く |
| 2 | Phase 2 | 評価レポート、UI 統合 |
| 3 | Phase 3 | stg 環境稼働 |
| 4 | 予備 + ドキュメント整備 | README 完成 |

⚠️ 他プロジェクトと並行するため 1日2〜3時間を想定。
遅れた場合の優先度は **Phase 2（評価設計）> Phase 1 > Phase 3**。
評価設計だけは何があっても完遂すること。
