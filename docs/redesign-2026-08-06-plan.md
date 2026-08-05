# osarAI 改修設計書 — AIチャット一本化・タスク機能・人物推測・重複検知（2026-08-06 プレゼン向け）

> 方針: 「情報過多を解消しシンプルに。複数の小さな入口を廃止し、AIチャットを唯一のメイン入口に統一する」
> 本書は既存実装（Osarai.tsx / AiChat.tsx / SelfOsarai.tsx、/api/osarai/turn、/api/self-osarai/turn、/api/advice、
> migrations 0001〜0025）を読んだ上での実装可能粒度の設計。コード変更はまだ行っていない。

---

## 1. 実装順の推奨（プレゼンに効く順）

| # | 項目 | 所要感 | デモ映え | 備考 |
|---|------|--------|----------|------|
| 1 | タスク基盤（migration 0026 + `lib/tasks.ts` + `Tasks.tsx` + 下部ナビ再編） | 小〜中 | 中 | 統合チャットの抽出先の受け皿。**最初にやる**（他が全部これに依存） |
| 2 | AIチャット一本化（`/api/assistant/turn`+`commit`、`AssistantChat.tsx`、3択ヒント・網羅的初回メッセージ・保存前確認カード） | 大 | **高** | デモの主役。「1画面で 予定/つながり/タスク がまとめて整理される」絵が最も刺さる |
| 3 | 相談の人物自動推測（顧客名簿をプロンプトに同梱 + 確認チップUI） | 小（#2に同梱） | **高** | 統合プロンプトの `customer_ref` として#2と同時実装するのが最安。単体改修より工数半減 |
| 4a | 重複つながり検知（**保存前**の「もしかしてこの人？」確認） | 小 | 中 | #2 の commit フローに正規化一致チェックを足すだけ。今夜可 |
| 4b | 商品名など固有名詞の名寄せ提示 | 小 | 低 | プロンプトに商品名簿を足すだけ。今夜可 |
| 4c | 既存重複の**事後検知＋統合（マージ）** | 大 | 低 | interactions/schedules/tasks の customer_id 付け替えRPCが必要。**今夜はやらない（後日）** |

推奨実施順: **1 → 2（3・4a・4b を同梱）**。4c は設計だけ提示して後日。

---

## 2. 設計詳細

### 2-1. AIチャット一本化（最優先）

#### 判断: 「既存 turn の拡張」ではなく「新API 2本の新設 + 永続化ロジックの lib 切り出し共有」

**結論: `POST /api/assistant/turn`（対話）と `POST /api/assistant/commit`（確認後保存）を新設する。既存3API・既存3画面は当面残す。**

理由（既存コードを読んだ上での根拠）:

1. **`/api/osarai/turn` はデータ契約が単一顧客前提**。`osarai_sessions.customer_id`（単数）、`resulting_interaction_id`（単数）、done 時に即 `persistOnDone()` で保存→事後編集、という構造（route.ts L241-291, L304-382）。今回の要件は「複数人・複数予定・複数タスクを一度に」「**保存前に**確認・編集」であり、テーブル契約と保存タイミングの両方が変わる。既存 turn に押し込むと `sessionId` を既に持つ既存クライアント（=リリース済みアプリ）との後方互換を壊す。
2. **`/api/advice` は `ai_chats`/`ai_chat_messages` 永続化と Light プランの月間上限カウント**（advice/route.ts L49-67: `ai_chat_messages` の user 行を count）に結合している。ここも流用はするが器は変えない。
3. **`/api/self-osarai/turn` はステートレス**（履歴クライアント持ち）で、統合チャットのセッションモデルに自然に吸収できる。
4. 一方で**永続化ロジックは実績があり再利用価値が高い**: `persistOnDone`（顧客作成/`merge_customer_custom_fields` RPC/温度感再計算/interaction作成/`merge_user_profile_fields`）、`mergeExtraction`/`mergeFields`/`mergeList`（0025 の累積マージ）。これらを `apps/web/lib/assistant-persist.ts` へ**移設**し、`/api/osarai/turn` からも import して挙動不変を保つ（既存 route の diff は import 置換のみ）。
5. deep link 依存が3箇所ある（後述リスク）ため、`Osarai.tsx` と `/api/osarai/turn` は **register モード/顧客指定モード専用として温存**し、素の `/osarai` は `/chat` へ redirect。段階的廃止。

#### セッション: 新テーブル `assistant_sessions`（migration 0026 に同梱）

`osarai_sessions` は単一 customer 前提のため流用しない。`accumulated_fields`（0025）の教訓を最初から適用し、ターン毎の抽出はサーバー側で累積マージして保持する。

```sql
-- 0026 内（tasks と同じファイル。DDL全文は §2-2 参照）
create table assistant_sessions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  user_id      uuid not null references profiles(id),
  messages     jsonb not null default '[]',   -- [{role, content}]
  accumulated  jsonb not null default '{}',   -- 抽出候補の累積 {people:[], schedules:[], tasks:[], self:{}}
  ai_chat_id   uuid references ai_chats(id),  -- consult発話のミラー保存先（Light上限カウント互換・後述）
  status       text not null default 'in_progress'
               check (status in ('in_progress','reviewing','done')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on assistant_sessions(user_id);

alter table assistant_sessions enable row level security;
-- osarai_sessions/ai_chats と同じ「本人のみ」（0002 の osarai_own パターン。leaderも他人の対話ログは見ない）
create policy assistant_sessions_own on assistant_sessions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

#### API契約

**`POST /api/assistant/turn`**（新規 `apps/web/app/api/assistant/turn/route.ts`）

```ts
// リクエスト
{
  sessionId?: string;
  message?: string;
  forceEnd?: boolean;              // 「ここまでで整理する」→ 確認フェーズへ
  confirmedCustomerId?: string | null; // 人物確認チップの回答（§2-3。'new'なら新規指定）
}
// レスポンス
{
  sessionId: string;
  reply: string | null;            // AIの返答（相談回答 or 深掘り質問）
  intent: 'record' | 'consult' | 'self' | 'unknown';
  customer_question: {             // 人物が曖昧な時のみ（§2-3）
    question: string;              // 「もしかして田中さんのお話ですか？」
    candidates: { id: string; name: string }[];
    allow_new: boolean;
  } | null;
  proposals: Proposals | null;     // done=true の時のみ返す（確認カードの初期値）
  done: boolean;                   // true = 確認フェーズへ遷移してよい
}
```

**`POST /api/assistant/commit`**（新規 `apps/web/app/api/assistant/commit/route.ts`）
ユーザーが確認カードで編集した最終版を受け取り、**ここで初めて**各テーブルへ書く（誤登録防止の確認ステップの実体。AIに保存させず、編集後JSONをサーバーが決定的に永続化する）。

```ts
// リクエスト
{
  sessionId: string;
  proposals: {
    people: Array<{
      customer_id: string | null;      // null=新規作成
      name: string;                    // 新規時必須（Osarai.tsx の名前必須バリデーションを踏襲）
      points: string[]; needs: string[]; next_actions: string[];
      custom_fields?: Record<string, unknown>;
    }>;
    schedules: Array<{ title: string; start_at: string; end_at: string;
      person_index: number | null;     // people配列への参照（新規顧客の予定紐付け用）
      location?: string; mode?: string; category?: string }>;
    tasks: Array<{ title: string; due_at: string | null; person_index: number | null }>;
    self_notes: string[];              // 自分について話した分（チェックで除外可）
    self_fields?: Record<string, string>;
  };
}
// レスポンス
{ customers: {id, name, isNew}[]; interactionIds: string[]; scheduleIds: string[]; taskIds: string[] }
```

commit の処理（`apps/web/lib/assistant-persist.ts` に集約。既存 `persistOnDone` の関数群を移設・拡張）:
1. 契約ゲート `getEntitlement`（全既存APIと同一）。
2. people ごとに: `customer_id` あり → `merge_customer_custom_fields` RPC + needs/last_met_at 更新 + `recomputeTemperature`（既存 persistOnDone L334-348, L452-468 と同一ロジック）。`customer_id` null → **保存前重複チェック（§2-4a）を通過後** insert。
3. people ごとに `interactions` insert（`source='ai_dialogue'`, `type='text'`, raw_text=対話全文, ai_summary={points,needs,next_actions}）。→ **Home の個人集計（stats.ts が `source='ai_dialogue'` を count）がそのまま生き続ける。**
4. schedules insert（既存 `schedules` テーブル。owner_id=auth.uid(), org_id, customer_id 解決済みで）。
5. tasks insert（新テーブル §2-2）。
6. self_notes/self_fields → `merge_user_profile_fields` RPC（0013。SelfOsarai の保存と同一経路）。
7. `assistant_sessions.status='done'`。

#### Gemini 呼び出し（1ターン=1回・レスポンススキーマ強制）

`geminiJson` + `GEMINI_MODEL_DIALOGUE`（既存 lib/gemini.ts のリトライ・フォールバックをそのまま使用）。応答スキーマ:

```ts
const ASSISTANT_TURN_SCHEMA: GeminiSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['record', 'consult', 'self', 'unknown'] },
    reply: { type: 'string', nullable: true },
    customer_ref: {   // §2-3 人物推測
      type: 'object',
      properties: {
        matched_id: { type: 'string', nullable: true },
        candidate_ids: { type: 'array', items: { type: 'string' } },
        mentioned_name: { type: 'string', nullable: true },
        needs_confirmation: { type: 'boolean' },
      },
    },
    extracted: {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' },
          matched_customer_id: { type: 'string', nullable: true },
          points: { type: 'array', items: { type: 'string' } },
          needs: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
          custom_fields: { type: 'object', properties: {   // 既存 TURN_SCHEMA と同じ明示列挙
            products: { type: 'array', items: { type: 'string' } },
            age: { type: 'string', nullable: true }, gender: { type: 'string', nullable: true },
          } },
        }, required: ['name', 'points', 'needs', 'next_actions'] } },
        schedules: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, date: { type: 'string' },        // YYYY-MM-DD（JST）
          start_time: { type: 'string', nullable: true },             // HH:mm
          end_time: { type: 'string', nullable: true },
          person_name: { type: 'string', nullable: true },
          location: { type: 'string', nullable: true }, mode: { type: 'string', nullable: true },
        }, required: ['title', 'date'] } },
        tasks: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, due_date: { type: 'string', nullable: true },
          person_name: { type: 'string', nullable: true },
        }, required: ['title'] } },
        self_notes: { type: 'array', items: { type: 'string' } },
        self_fields: { /* 既存 self-osarai TURN_SCHEMA の fields と同一 */ },
      },
      required: ['people', 'schedules', 'tasks', 'self_notes'],
    },
    done: { type: 'boolean' },
    end_reason: { type: 'string', enum: ['user_request', 'enough'], nullable: true },
  },
  required: ['intent', 'reply', 'extracted', 'done'],
};
```

サーバー側でターン毎に `accumulated` へマージ（既存 `mergeExtraction` の people/schedules/tasks 版。people は `name` 正規化キーで、schedules/tasks は `title+date` キーで重複統合）。**Gemini がターンによって項目を落としても累積が守る**（0025 と同じ設計判断）。

日時解決: プロンプト冒頭に **JST の現在日時と曜日**を渡し（`@osarai/shared` の jst.ts を利用）、「来週火曜の14時」等を Gemini に YYYY-MM-DD/HH:mm で出させる。サーバーは date+time → timestamptz（JST→UTC）に変換。end_time 未指定は start+1時間（Schedule.tsx の既定に合わせる）。

#### プロンプト方針（新規 `packages/shared/src/prompts/assistant.ts`）

既存3プロンプト（OSARAI_SYSTEM_PROMPT / SELF_OSARAI_SYSTEM_PROMPT / ADVICE_SYSTEM_PROMPT）を1本に統合。骨子:

- 役割: 「osarAI のパートナーAI。ユーザーの発話から**意図を自分で判断**して振る舞いを切り替える」
  - `record`: 人と会った話・出来事の報告 → おさらいインタビュアーとして振る舞う（既存 OSARAI の抽出規律をそのまま移植: 推測禁止・雑談も points に拾う・custom_fields は毎ターン全量再抽出）
  - `consult`: 相談・質問 → 営業コーチとして回答（既存 ADVICE の「結論先出し・箇条書き2〜4個・ゴリゴリ売り込み禁止」を移植）
  - `self`: 自分自身の話 → self_notes/self_fields に抽出（既存 SELF_OSARAI の規律を移植）
  - 1発話に複数意図が混在してよい（例: 出来事報告の中に相談が混ざる）。抽出と回答は両方行う
- **複数エンティティ抽出**: 「1発話に複数の人物・複数の予定・複数のタスクが含まれうる。全て漏らさず people/schedules/tasks の配列に抽出する」
- 深掘り質問は record 意図のときのみ・1問ずつ・短く（既存踏襲）。consult には質問ではなく回答を返す
- **既存タイマー（5分・remainingSec）は統合チャットでは廃止**（判断: 「唯一の入口」に常駐する画面に制限時間は不自然。終了は AI の done 判定 + ユーザーの「ここまでで整理する」ボタンの2系統に簡素化。既存 Osarai.tsx の早期終了ガードは持ち込まない）
- コンテキストとして毎ターン渡すもの:
  1. JST現在日時
  2. **顧客名簿**（§2-3。id/名前/関係性/ニーズ1行 × active 上限100件）
  3. **商品名簿**（§2-4b。agency_products.name + user_profile.products[].name）
  4. ユーザー自身のプロフィール（既存 `formatUserProfile`）と蓄積 notes（self-osarai/turn L83-93 と同じ取得）
  5. フォーカス顧客が確定しているセッションでは、その顧客の履歴詳細（既存 `buildContext(scope='customer')` を流用）
- consult 用の全顧客サマリは 2 の名簿がそのまま兼ねる（`buildContext(scope='all')` 相当の1行形式に揃える）→ **Gemini 呼び出しはターンあたり1回で済む**（意図分類→本回答の2段呼び出しはしない。レイテンシ優先）

#### Light プラン上限との互換（consult ミラー保存）

advice の月10回制限は `ai_chat_messages` の user 行 count で実装されている。統合チャットの consult 発話がここを素通りすると制限が壊れるため:
- セッション初の consult 発話時に `ai_chats` を1件 lazy 作成（scope='all', title=発話冒頭40字）し `assistant_sessions.ai_chat_id` に記録
- 以降 intent=consult のターンは user/assistant 発話を `ai_chat_messages` にもミラー insert
- turn API 冒頭で advice/route.ts L49-67 と同一の上限チェックを行い、超過時は「相談は上限。記録は引き続き可能」と reply で案内（402/429 で弾かず対話は続行）

#### モバイル画面（新規 `apps/mobile/src/screens/AssistantChat.tsx`、ルート `/chat`）

Osarai.tsx / AiChat.tsx の実証済みパターンをそのまま移植する:
- 送信キュー方式（`queue` + `processingRef` + AbortController + 停止ボタン）— AiChat.tsx L36-131
- マイク入力（`useRecorder` + `useLiveSpeech` + `/api/osarai/stt` transcribe + 失敗時リトライ）— Osarai.tsx L198-233
- `ScreenHeader` / `AutoResizeTextarea` / `useRegisterNavGuard`（未保存対話中の離脱確認）/ 送信フォーム fixed 配置（Osarai.tsx L367-377 の実測 padding 方式）
- 完了時 `ConfettiBurst` 達成演出（Osarai.tsx L477-521）

**初回メッセージ**（固定1種でよい。網羅性が仕様）:

```
今日のこと、まとめて話してください。予定・つながり・タスクをAIが整理します。

例:「今日は〇〇のイベントに参加しました。〇〇さんと話して、
〇月〇日の〇時に〇〇でお会いする約束をしました。
それまでに〇〇の資料を送るタスクがあります。」

複数の人・複数の予定をまとめて話して大丈夫です。相談したいことがあれば、それもどうぞ。
```

**3択ヒント**（既存 HINTS バブルUI・Osarai.tsx L61-65/L632-652 を流用。`messages.length===1 && !sending` のときのみ表示）:

```ts
const HINTS = [
  { label: '今日の出来事を話す', message: '今日あったことを話したいです。' },
  { label: 'AIに相談する', message: '相談したいことがあります。' },
  { label: '自分のことについて話す', message: '自分のことについて話したいです。' },
];
```

**状態遷移**:

```
idle（初回メッセージ+3択ヒント）
  → chatting（turn往復。customer_question が来たら候補チップを割り込み表示 → 選択で confirmedCustomerId 付き再送）
  → reviewing（done=true or「ここまでで整理する」→ proposals を確認カードで表示・編集）
  → committed（/api/assistant/commit 成功 → ConfettiBurst → 「続けて話す」= startNewSession）
```

**確認カード（reviewing）**: Osarai.tsx のサマリ編集フォーム（L522-580）を拡張した3セクション構成。
- 「つながり」: 人物ごとにカード。名前（新規は必須・既存は表示のみ）/要点/ニーズ/次アクション（1行1項目 textarea・既存と同形式）。人物単位の削除（誤抽出破棄）チェック
- 「予定」: タイトル/日時（`datetime-local`）/相手/場所。行単位で削除可
- 「タスク」: タイトル/期限（`date`）/相手。行単位で削除可
- 各セクション0件なら非表示。「この内容で保存」1ボタンで commit

**ナビ・導線の再編**（変更ファイル）:
- `apps/mobile/src/components/BottomNav.tsx` — TABS を `ホーム / AIチャット(/chat) / 予定 / タスク(/tasks) / マイページ` に（おさらい・相談の2タブ→AIチャット1タブ、空き枠にタスク）
- `apps/mobile/src/App.tsx` — `/chat`→AssistantChat、`/tasks`→Tasks 追加。`/osarai` はクエリ無しなら `<Navigate to="/chat"/>`、`customerId`/`mode=register` 付きは既存 Osarai.tsx を維持（deep link 3箇所を壊さない: CustomerDetail.tsx L155 / CustomerForm.tsx L126 / Schedule.tsx L491）
- `apps/mobile/src/screens/Home.tsx` — 「おさらいする」「AIに相談」の2ボタン（L199-206）→「AIと話す」1ボタン（/chat）
- `apps/mobile/src/screens/Settings.tsx` — 「自分をおさらいする」ボタン → `/chat`（③ヒントの案内文言に変更）。`/self-osarai` ルート自体は welcome オンボーディング（`from=welcome`）専用として温存
- `apps/mobile/src/lib/assistant.ts` — 新規クライアント（lib/osarai.ts と同型の apiPost ラッパ: `assistantTurn` / `assistantCommit`）

**既存3画面・3APIの扱い**: AiChat.tsx は `/chat` から外れて未参照化（削除は次リリースで）。Osarai.tsx は register/顧客指定専用。SelfOsarai.tsx は welcome 専用。API は3本とも残す（温存画面と、ストアの旧バージョンアプリが叩き続けるため）。

---

### 2-2. タスク機能（新規）

#### 項目設計（MVP最小）

必須（要件指定）: **title（文章形式）/ due_at（期限）/ customer_id（つながり）**。

追加を提案する項目（最小限）:

| 列 | 理由 |
|---|---|
| `status` ('open'/'done') + `completed_at` | 完了チェックが無いタスク管理は成立しない。完了日時は実績表示・将来の集計用 |
| `notes` (text, null可) | 一言メモ。schedules.notes（0015）と同じ位置づけ |
| `source` ('manual'/'assistant') | AIチャット抽出由来か手動かの区別。誤抽出の追跡・将来の精度改善に必要 |

**採用しない**もの（MVPスコープ維持の判断）: 優先度・タグ・繰り返し・サブタスク・リマインダー時刻（リマインドは既存 cron 基盤で将来対応）・担当者アサイン（個人ツールのため不要）。

DDL 上の注意: `customer_id` は要件上「必須」だが、DDL は **nullable + on delete set null** とする（schedules の前例 0008 と同じ。つながり削除時にタスクを道連れにしない）。必須制約はアプリ層（作成フォーム・commit API）で担保する。ただし「自分自身のタスク」（誰にも紐づかない）も現実に発生するため、UI 上は「つながりなし」を明示選択できる形を推奨（要件と相談。既定は必須のままでも実装は同じ）。

#### migration 案（`supabase/migrations/0026_tasks_and_assistant_sessions.sql`・追加のみDDL）

0008_schedules.sql / 0020_agency_products.sql の書式（コメントで経緯→DDL→index→RLS）に完全準拠:

```sql
-- タスク管理機能（AIチャット一本化改修・2026-08-06）。AIチャットの発話から抽出される
-- 「スケジュール/つながり/タスク」3種のうちタスクの保存先。手動追加(タスク一覧画面)にも使う。
-- schedules(0008) と同じ org_id + owner_id=auth.uid() スコープのRLSパターンを踏襲。
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  owner_id     uuid not null references profiles(id),
  customer_id  uuid references customers(id) on delete set null,
  title        text not null,
  due_at       timestamptz,
  status       text not null default 'open' check (status in ('open','done')),
  completed_at timestamptz,
  source       text not null default 'manual' check (source in ('manual','assistant')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on tasks(org_id);
create index on tasks(owner_id);
create index on tasks(customer_id);
create index on tasks(due_at);

alter table tasks enable row level security;

-- tasks: member=自分の分のみ / leader=同組織すべて閲覧可（schedules/customersと同じ方針）
create policy tasks_select on tasks for select
  using (
    org_id = current_org_id()
    and (current_user_role() = 'leader' or owner_id = auth.uid())
  );
create policy tasks_cud on tasks for all
  using (org_id = current_org_id() and owner_id = auth.uid())
  with check (org_id = current_org_id() and owner_id = auth.uid());

-- （assistant_sessions の DDL は §2-1 参照。同ファイルに同梱）
```

適用後の作業（実装者向けメモ・本設計では実行しない）: `supabase db push` は人の運用ルールに従い、`supabase gen types typescript --linked > packages/shared/database.types.ts` を再生成してコミット。

#### クライアント & 一覧画面

- 新規 `apps/mobile/src/lib/tasks.ts` — `lib/schedules.ts` L26-93 と同型の supabase 直 CRUD:
  `listTasks({ status })` / `createTask(input)`（getMyProfile で org_id 取得→insert。createSchedule と同型）/ `updateTask(id, input)` / `toggleTaskDone(id, done)`（status + completed_at を同時更新）/ `deleteTask(id)`
- 新規 `apps/mobile/src/screens/Tasks.tsx`（ルート `/tasks`・下部ナビ「タスク」）最小仕様:
  - **一覧**: open タスクを due_at 昇順（null は末尾）。セクション分け: `期限切れ`（赤系・`var(--color-danger)`）/ `今日` / `今後` / `期限なし`。完了済みは折りたたみ（直近20件）
  - **行**: チェックボックス（タップで toggleTaskDone・即時反映）+ タイトル + 期限（相対表記: 今日/明日/M月D日）+ つながり名チップ（タップで `/customers/:id`）
  - **追加**: 画面右下の「＋」→ モーダル（タイトル textarea / 期限 date / つながり select=listCustomers。CustomerForm の入力パターン踏襲）
  - **編集/削除**: 行タップで同モーダルを編集モードで開く。削除は `useConfirm` で確認（既存パターン）
  - 空状態: 「タスクはありません。AIチャットで今日のことを話すと、タスクも自動で整理されます」（統合チャットへの導線）

既存 `interactions.ai_summary.next_actions` との関係: next_actions は「対話の記録」として従来どおり残し、**タスク化はしない**（自動二重登録を避ける）。統合チャットでは「期限・具体性のあるものを tasks に、それ以外の含みを next_actions に」とプロンプトで書き分けさせる。

---

### 2-3. 相談の人物自動推測

#### 判断: プロンプト方式（顧客名簿をコンテキストに同梱し Gemini に候補を返させる）+ サーバー側ガード

理由:
- 1ユーザーの active つながりは高々数十〜数百件。`id + 名前 + 関係性 + ニーズ1行` の名簿はコンテキストに余裕で収まる（buildContext の scope=all が既に上限50件で同じことをしている）
- 表記揺れ（漢字/かな/あだ名/「田中さん」vs「田中太郎」）の解決は LLM が最も得意。pg_trgm 等のDB側名寄せは日本語人名の揺れ（読み仮名）に弱く、拡張導入の migration も増える
- **ガード必須**: Gemini が返す `matched_id` が名簿に無い id（幻覚）の場合はサーバーで `needs_confirmation=true` に矯正する。これで「勝手に進めない」を決定的に担保

#### フロー

1. turn API は毎ターン、名簿（`apps/web/lib/customer-context.ts` に `buildRoster(supabase)` を追加: `id / name / relation_type / needs / last_met_at` × active 100件）をプロンプトへ
2. Gemini は `customer_ref` を返す:
   - 確度高（名簿内で一意に特定）→ `matched_id` セット・`needs_confirmation=false` → そのまま進行。セッションのフォーカス顧客として以降のターンで履歴詳細（`buildContext(scope='customer')`）を同梱
   - 曖昧（同姓複数・部分一致のみ・初出の名前）→ `candidate_ids`（0〜3件）+ `needs_confirmation=true` → サーバーが `customer_question` を組み立てて返す: 「もしかして**田中太郎**さんのお話ですか？」+ 候補ボタン + **「新しい人です」**（`allow_new: true`）+「わからない/その他」
3. クライアント（AssistantChat.tsx）は `customer_question` を受けたら候補チップ（HINTS バブルUIの流用）をAI吹き出し直下に表示。選択すると次リクエストに `confirmedCustomerId`（'new' 含む）を積んで送信。以降そのセッションではその人物として確定（`accumulated` に記録）
4. **AIから確認を強制するプロンプト規律**: 「人物が一意に特定できない限り、その人の履歴を前提にした回答・記録の紐付けをしてはならない。必ず確認する」

既存 AiChat.tsx のプルダウン（L152-171 の scope/customer select）はこの仕組みで**廃止**（統合チャットには置かない）。`?customerId=` 付き遷移（CustomerDetail からの「この人について相談」）は `/chat?customerId=xxx` で受け、初回からフォーカス顧客確定状態で開始する。

---

### 2-4. 表記揺れ・重複つながりの検知

#### 4a. 保存前の重複検知（「もしかしてこの人ですか？」）— **軽い・今夜可**

2層で防ぐ:
1. **LLM層（無料で手に入る）**: §2-3 の名簿が毎ターン渡っているため、「田中さん」と発話された時点で Gemini が `matched_customer_id` を返す。新規と判断された人物のみ `customer_id: null` で proposals に載る
2. **commit 層（決定的ガード）**: `apps/web/lib/assistant-persist.ts` に `findSimilarCustomers(name)` を実装。新規作成しようとする名前を正規化（`String.prototype.normalize('NFKC')` → 空白除去 → 敬称除去「さん/様/氏/くん/ちゃん」）し、既存 active 顧客名（同じ正規化を適用）と **完全一致 or 前方/部分一致（2文字以上）** を照合。ヒットしたら commit を実行せず `409 { duplicates: [{index, candidates:[{id,name,last_met_at}]}] }` を返す → クライアントは確認カード上に「もしかして既存の**田中太郎**さん（最終接触 7/20）ですか？」→ 「同じ人（既存に統合して記録）」/「別の人（新規作成）」を選ばせて再 commit（選択結果は `customer_id` セット or `force_new: true` で表現）

「既存に統合して記録」を選んだ場合は新規作成せず、その customer_id への update + interaction 追加になる（§2-1 commit 手順2の既存分岐に乗るだけ）。

**判定: 軽い（今夜○）**。正規化関数 + 1クエリ + 確認UI1枚。migration 不要。

#### 4b. 商品名など固有名詞の名寄せ提示 — **軽い・今夜可**

- プロンプトに**商品名簿**を同梱: `agency_products.name`（同組織・RLS select は全員可）+ `profiles.user_profile.products[].name` + 既存 customers の `custom_fields.products` の distinct
- プロンプト規律: 「商品・サービス名を聞き取った際、名簿に近い名称があれば名簿側の正式名称で抽出し、reply で『〇〇のことですね』と一言確認する。近いものが無ければ聞き取ったまま抽出する」
- **判定: 軽い（今夜○）**。プロンプト+名簿取得クエリのみ。専用UIも不要（AIの発話内で確認が完結）

#### 4c. 既存重複の事後検知＋統合（マージ） — **重い・今夜はやらない**

必要になるもの:
- 統合RPC（新 migration）: `merge_customers(keep_id, remove_id)` — interactions / schedules / tasks / osarai_sessions / ai_chats の customer_id 付け替え + `custom_fields` の jsonb マージ + needs/points の結合 + remove 側を archive。RLS 下で本人所有チェック付きの security definer 関数
- 検知バッチ or 一覧画面での類似ペア表示UI + マージ確認UI（どちらを残すか・フィールド衝突の解決）
- **判定: 重い（今夜×）**。4a で「これ以上増やさない」を先に止血し、既存分の統合は次スプリント。プレゼンでは「保存前ガードで新規流入を止め、既存分は統合機能を追って提供」と説明するのが誠実

（代替案として pg_trgm + similarity index も検討したが、ユーザーあたりの件数規模と日本語人名の読み揺れ特性から、名簿 in プロンプト方式で十分・拡張導入は過剰と判断。）

---## 3. 今夜やるべき最小セット（「シンプルになった」が伝わる組み合わせ）

**A. migration 0026（tasks + assistant_sessions）＋ 型再生成** — 全ての土台。30分想定
**B. タスク一覧（lib/tasks.ts + Tasks.tsx + ナビ再編）** — schedules.ts の写経で早い
**C. 統合チャット（assistant.ts プロンプト / turn + commit API / AssistantChat.tsx / Home・Settings 導線変更）** — 本丸。§2-3 の人物推測と §2-4a/4b はこの中に同梱実装（別作業にしない）
**D. デモ用シナリオの通し確認** — 「今日は交流会で田中さんと佐藤さんに会った。田中さんとは金曜14時にカフェで再会予定、それまでに資料送付タスク。ところで佐藤さんへの提案、どう切り出すのがいい？」→ 1発話で record+consult 混在・複数人・予定・タスク・人物推測・確認カードまで**全機能が1画面で見える**

**今夜削ってよいもの**（デモ品質に響かない順）:
1. 4c 統合マージ（設計提示のみ）
2. マイク入力の移植（既存 hooks 流用なので入れやすいが、テキストデモで成立する）
3. SelfOsarai/welcome フローの統合（既存のまま触らない）
4. 旧画面の削除・クリーンアップ（未参照化のみで良い）

フル実装（A+B+C+D）が第一候補。時間切れの場合の縮小ラインは「C の consult ミラー保存（Light上限互換）を TODO コメントで後日に回す」まで（機能ゲートより先にデモ体験を優先。ただしリリース前に必須）。

---

## 4. リスク（既存ユーザーへの影響・壊れやすい所）

| リスク | 影響 | 対策（本設計での手当て） |
|---|---|---|
| `/osarai` への deep link 3箇所（CustomerDetail.tsx L155・CustomerForm.tsx L126「AIと対話して登録」・Schedule.tsx L491 登録提案モーダル） | register/顧客指定フローが死ぬ | Osarai.tsx と /api/osarai/turn をクエリ付き専用で温存。素の /osarai のみ /chat へ redirect |
| Light プランの AI相談 月10回上限が `ai_chat_messages` count に結合 | 統合チャット経由の相談が無制限になる/課金 fence 崩壊 | consult ターンを ai_chats/ai_chat_messages へミラー保存（§2-1）。リリース前必須 |
| Home の個人集計（stats.ts が `interactions.source='ai_dialogue'` を count）・リーダーDashboard | おさらい数が減って見える | commit で従来どおり interactions(source='ai_dialogue') を作るため互換維持。consult のみのセッションは interaction を作らない（=正しくカウント外） |
| **保存タイミングの変更**（既存: done時に即保存→事後編集。新: commit まで未保存） | 確認前に離脱すると記録が消える | useRegisterNavGuard で離脱確認（既存パターン必須適用）+ assistant_sessions.accumulated がサーバーに残るため復帰導線を将来追加可能。**ここが今回最大の挙動変更点** |
| Gemini 構造化出力の複雑化（ネスト配列3種+intent） | 項目の取りこぼし・レイテンシ増・スキーマ違反 | サーバー側累積マージ（0025の教訓を最初から適用）+ lib/gemini.ts の既存リトライ/フォールバック + required 明示。長い1発話デモは事前に実データでプロンプト調整必須 |
| 日時抽出の誤り（「来週火曜」等の相対日付） | 誤った予定登録 | JST現在日時をプロンプト固定注入 + 確認カードで必ず datetime を目視編集させる（誤登録防止ステップが仕様上必ず挟まる） |
| ストア配信済み旧バージョンアプリ | 旧 API を叩き続ける | 既存3APIを削除しない（レスポンス契約も不変更。osarai/turn の変更は persist 関数の import 置換のみ） |
| 旧タブ構成に慣れた既存ユーザー（app.osarai.app は本番稼働中・実データあり） | 「おさらい」「相談」タブ消失の混乱 | タブ名は「AIチャット」+ 初回メッセージで新しい話し方を明示。プッシュ通知の文言/遷移先（push/remind・cron 系）の /osarai 参照有無をリリース前に確認し /chat へ更新 |
| tasks の leader 閲覧範囲 | 「leader は同組織すべて閲覧」を schedules に合わせたが、タスクは私的メモ性が高い | 本設計は schedules 準拠（閲覧のみ）。プライバシー要件が違うなら policy を own-only に変えるだけ（0022 の own-only 前例あり） |
| 重複検知の誤爆（同姓の別人を「同じ人？」と聞く） | 体験の軽い摩擦 | 4a は**確認するだけ**で自動統合はしない設計のため実害なし。「別の人」を選べば従来どおり新規作成 |

---

## 付録: 触るファイル一覧（サマリ）

**新規**
- `supabase/migrations/0026_tasks_and_assistant_sessions.sql`
- `packages/shared/src/prompts/assistant.ts`（+ `src/index.ts` に export 追記、`src/types.ts` に AssistantTurnResult/Proposals 型追記）
- `apps/web/app/api/assistant/turn/route.ts` / `apps/web/app/api/assistant/commit/route.ts`
- `apps/web/lib/assistant-persist.ts`（osarai/turn/route.ts から persistOnDone・merge系・recomputeTemperature を移設+拡張）
- `apps/mobile/src/lib/assistant.ts` / `apps/mobile/src/lib/tasks.ts`
- `apps/mobile/src/screens/AssistantChat.tsx` / `apps/mobile/src/screens/Tasks.tsx`

**変更**
- `apps/mobile/src/App.tsx`（ルート追加・/osarai 条件 redirect）
- `apps/mobile/src/components/BottomNav.tsx`（TABS 再編）
- `apps/mobile/src/screens/Home.tsx`（入口ボタン統合）
- `apps/mobile/src/screens/Settings.tsx`（自分をおさらい導線→/chat）
- `apps/web/app/api/osarai/turn/route.ts`（persist 関数の import 置換のみ・挙動不変）
- `apps/web/lib/customer-context.ts`（buildRoster/商品名簿ヘルパ追加）
- `packages/shared/database.types.ts`（gen types 再生成）

**検証**: `pnpm -r typecheck` → `pnpm -r build`。ブランチは既存運用どおり dev 基点の feature ブランチ（例 `feat/assistant-unified-chat`）。
