---
description: プロジェクトの本番反映を、各本番操作の承認を取りながら進めるエージェント
argument-hint: "[empty|進めて|段階の指示]"
disable-model-invocation: true
model: sonnet
---

プロジェクトの本番反映を、各本番操作の承認を取りながら進めるエージェント。

> **モデル**: 既定は Sonnet 5（1次実行・定型ゲート運用）。本番migrationの是非判断・切り戻し判断・想定外の異常対応など**判断が重くなった局面では、人が会話内でモデルを Opus 4.8 に上げてから続行する**（自動エスカレーションはしない。基準は DECISIONS.md T16）。

> **【正本（~/cc-pipeline）・プロジェクト中立版】** 固有値（本番ref・本番URL・デプロイコマンド・scope 等）はハードコードしない。各リポの **CLAUDE.md「Pipeline設定」** と `.env` を参照（`{{PROD_BRANCH}}` / `{{DEPLOY_PLATFORM}}` / `{{PROD_URL}}` / `{{DEPLOY_TRIGGER}}` / `{{DEPLOY_CMD}}` 等の `{{...}}` はその参照）。通知は `scripts/notify-humanball.mjs` が `.env` の `NOTIFY_PREFIX` を自動付与する。
>
> **デプロイ機構 `{{DEPLOY_TRIGGER}}`（CLAUDE.md「Pipeline設定」/`.env`）で本番反映の形が分岐する**：
> - **`auto-on-merge`** … `{{PROD_BRANCH}}` への Merge ＝ {{DEPLOY_PLATFORM}} が自動デプロイ。**Merge承認ゲート（手順6）がデプロイも兼ねる**（手順7のデプロイ実行はスキップ）。
> - **`manual-cli`** … Merge では自動デプロイされない。**Merge（手順6）後に手動デプロイ別ゲート（手順7・`{{DEPLOY_CMD}}` 例 `vercel --prod --scope <scope>`）** を人承認後 CC が実行。

> 本番反映は **PR経由**。Merge は人がタイミングを明示承認した時だけ CC が `gh pr merge`。`manual-cli` では本番デプロイも人承認後に CC が `{{DEPLOY_CMD}}` を実行（＝本番承認ゲート）。品質担保は **ローカルE2E全green＋独立AIレビュー＋RLS監査＋本番反映後のスモーク（ハードリロード必須）**。

> **対象は「本番待ち」のみ**。CC（/run・/next）の完成品は **レビュー待ち** に着地し、**人がレビュー承認して「本番待ち」へ昇格**したものだけが本番反映の対象。**レビュー待ち（未レビュー）は /ship が構造上拾わない**（＝未レビューが本番に出ない安全装置）。

> **承認待ちの提示（画面）と `--detail`（LINE）は CLAUDE.md「人ボール報告フォーマット（必須）」に従う**：結論先頭・A/B・推奨1行。通知 kind は `ship承認`（Merge/デプロイ/migration タイミング）と `ship-blocked`/`ship-ready`（ゲート判定）で混線させない。

# 前提

- `{{PROD_BRANCH}}` = 本番、`dev` = 統合用。本番 Supabase ref・本番URL `{{PROD_URL}}` は CLAUDE.md「Pipeline設定」記載。
- 本番反映は dev → PR → `{{PROD_BRANCH}}`。**CCは `{{PROD_BRANCH}}` へ直接 push しない**。Merge は人がタイミングを明示承認した時だけ CCが `gh pr merge`（ブランチ保護＝gh認証経由・人承認前提）。
- **デプロイは `{{DEPLOY_TRIGGER}}` に従う**（上記）。`manual-cli` は Merge と本番デプロイが別ステップ（手順6・手順7）。`auto-on-merge` は Merge＝デプロイ（手順7はスキップ）。dev は preview/自動反映なし → 品質担保は **ローカルE2E全green＋独立AIレビュー＋RLS監査＋本番スモーク**。
- **緊急hotfix（`{{PROD_BRANCH}}`派生）の独立ship**：/run の緊急レーンが作った本番待ちのうち、📋に「**緊急hotfix・ブランチ=`hotfix/<slug>`（main派生・未push）**」と記され、ローカルに `hotfix/*` ブランチがあるものは、**dev を経由せず独立してshipする**（§緊急hotfix独立ship）。通常の本番待ち（dev上）は従来どおり dev→PR→`{{PROD_BRANCH}}`。
- supabase db push は絶対禁止。DB変更は正式なmigration（追加のみ・後方互換）でのみ。
- **本番migration適用は、人の明示承認＋追加のみDDLに限りCCが psql で実行可**（`.env` の `SUPABASE_PROD_DB_URL`。値はログ/チャットに残さない）。破壊的を1つでも含むなら人手のSQLエディタ実行＋事前バックアップ（CCは実行しない）。適用は **本番反映（Merge or デプロイ）より前** に行う。
- **リスク別の ship 手数（スモークの深さをリスクで変える）**：差分に含まれる最大リスクで判断。
  - **🟢低のみ**：本番反映後のスモークは「本番URL描画/200・JSエラー無し」の軽確認でOK（ノールック寄り）。
  - **🟡中**：関係画面を本番でハードリロードし、主要動線を1往復。
  - **🔴高/🧱土台（金額・認証・データモデル・外部送信・cross-tenant）**：**本番スモーク必須**。各本文の🧪「ship前スモーク」を本番で実施し、**金額/集計系は変更前後で数値が正しいか**まで見る。**外部送信（LINE/メール/push/決済）は🔴時のみ・必ず自テナント自分宛・隔離で実施**（通常は手順8の認可ガード疎通＝実送信ゼロで済ます）。
  - 独立AIレビュー(手順4.5)の runs 数も差分リスクで上げる（🔴高は `--runs 3`）。

# 手順

1. プリフライト（読み取りのみ・自動／git状態・dev最新化）:
   - `git log --oneline origin/{{PROD_BRANCH}}..origin/dev` で「本番に乗る差分」を一覧化。
   - 差分に DB migration / webhook・cron・edge functions 変更 / 破壊的変更 が含まれるか分類して提示。
   - 本番待ちのNotionタスクを一覧化（`node --env-file=.env scripts/next-target.mjs --board` の「本番待ち」グループ）し、今回どれが反映されるか対応づけ。**緊急hotfix（hotfix/* ・main派生・未push）が本番待ちにあれば §緊急hotfix独立ship へ**。
   - 後方互換か・ロールバック可能かのリスク要約を出す。
   - dev を最新化： `git switch dev && git push origin dev`。

2. migrationチェック（事前検知①・読み取りのみ・自動）:
   - `git diff --name-only origin/{{PROD_BRANCH}}...origin/dev` で `{{MIGRATIONS_DIR}}`（既定 `supabase/migrations/`）配下の新規/変更ファイルを列挙。
   - **該当あり**：後続のPR本文に「## ⚠️ migration あり」セクションを作り、ファイル名・概要・後方互換性（追加のみか／破壊的か）・本番適用要否を明記する。
     - 追加のみ＝ADD COLUMN / CREATE TABLE / CREATE INDEX / ADD CONSTRAINT 等の非破壊DDLのみ → 手順5で人の承認後にCCが psql 適用可。
     - 破壊的＝DROP / DELETE / TRUNCATE / UPDATE / 型変更（ALTER ... TYPE）/ NOT NULL追加 等 → CCは適用しない。本番DBのバックアップ取得済みかを確認し、未取得なら促して停止。停止直前に：
       `node scripts/notify-humanball.mjs --kind ship承認 --task "<PRタイトル>" --detail "破壊的migrationN件あり/A.バックアップ後SQLエディタで手動実行 B.中止／推奨A（CCは適用しない）" [--url "<セッションurl>"]`
   - **該当なし**：PR本文に「migration: なし」と明記。

2.5 RLS/anon 監査ゲート（決定的・機械的／LLMレビューの二重化・読み取りのみ・自動）:
   - 判定源は **`.kody/accepted.yml`（手順4.5 と共有）**。**migration適用済の状態**（ローカル＝本番反映後と同一スキーマ。`.env` の `LOCAL_DB_URL`）に対し実行：`node scripts/rls-audit.mjs --assert`（必要なら `--prod-readonly` で本番を読取専用監査＝SELECTのみ・書込なし）。
   - **allowlist外で「anon到達可 × RLS無効」= 🔴LEAK** が1件でもあれば `--assert` 非ゼロ終了 → **HALT**。違反テーブル一覧を提示し、停止直前に：
     `node scripts/notify-humanball.mjs --kind ship-blocked --task "<PRタイトル>" --detail "RLS監査で🔴LEAK N件(anon×RLS無効)/A.RLS有効化migration B..kody/accepted.ymlに追跡追記／推奨A、再実行で続行" [--url "<セッションurl>"]`
   - **🔴LEAK 0 → 続行**。📋に監査サマリ（public表数・LEAK/warn/allowlist件数・verdict）を載せる。

3. PR作成（CCが自動）:
   - `gh pr create --base {{PROD_BRANCH}} --head dev --title "release: <要約>" --body "<反映タスク一覧（Notion）／migration有無／RLS監査サマリ／後方互換性／スモーク観点>"`。作成後 PR URL を表示。

4. 品質担保（ローカルE2E全green・自動／preview は使わない）:
   - dev は preview/自動反映なし → preview 確認はしない・案内しない。
   - **ローカルE2Eを全green**：`{{TEST}}`（CLAUDE.md「Pipeline設定」TEST）を実行し、反映差分に関係する `scripts/verify-*.mjs` も実行して全 green を確認。1つでも fail なら停止（本番反映に進まない）。
   - 残りは本番反映後のスモーク（手順8・ハードリロード必須）で担保。

4.5 独立AIレビュー ゲート（本番反映の直前・自動）:
   - **本番に乗る差分**に対し独立レビュー（Claude非依存の Gemini・`.env` の `GEMINI_REVIEW_API_KEY`/`GEMINI_REVIEW_MODEL`）を **2〜3回 union 実行**（🔴高は `--runs 3`）：
     `node scripts/independent-review.mjs --json --runs 3 "origin/{{PROD_BRANCH}}...origin/dev"`（JSONで `verdict` / `riskClass` / `accepted`）。
     - **どれか1回でも未acceptの critical/🔴 が出たら union に残り verdict=block**（保守的＝prodゲートは false-negative を避ける）。
   - **verdict=block → HALT**：findings を提示し、停止直前に：
     `node scripts/notify-humanball.mjs --kind ship-blocked --task "<PRタイトル>" --detail "独立レビュー verdict=block（未accept🔴N件）/A.修正 B..kody/accepted.yml追記／推奨A、再実行で続行" [--url "<セッションurl>"]`
   - **verdict=pass → 続行可（本番反映は人間の confirm 後）**：停止直前に：
     `node scripts/notify-humanball.mjs --kind ship-ready --task "<PRタイトル>" --detail "独立レビュー verdict=pass / risk=<high|low> / accepted=[…]。確認後OKで本番反映へ" [--url "<セッションurl>"]`
     - **riskClass=high** の時は特に、人間が中身を確認してから confirm する旨を明示。

5. ★本番migration適用（追加のみ／本番反映より前・順序の罠回避）:
   - **重要：本番反映（auto-on-merge=Merge / manual-cli=デプロイ）が新フロントを公開するので、migration はそれより前に適用する**（新フロントが未適用スキーマを叩く事故を防ぐ）。追加のみDDLは後方互換なので Merge 前後どちらでも・本番反映前に適用すればよい。
   - **追加のみDDLの場合のみ**、CCが適用してよい（破壊的を含むなら手順2で人手＋バックアップ依頼済み・ここはスキップ）：
     1. 停止直前に：`node scripts/notify-humanball.mjs --kind ship承認 --task "<PRタイトル>" --detail "本番migration適用待ち(追加のみN件)/A.「実行して」で psql 適用 B.保留／推奨A" [--url "<セッションurl>"]`
     2. 人が「実行して」等で承認 → `origin/{{PROD_BRANCH}}..dev` 差分の未適用 `{{MIGRATIONS_DIR}}` ファイルを **内容そのまま** 1つずつ：`psql "$SUPABASE_PROD_DB_URL" -v ON_ERROR_STOP=1 -f <file>.sql`（URLは `.env` 参照・ログ/チャットに出さない・db push 禁止）。追加のみを適用直前に再確認。
     3. 適用後、**本番REST**で対象列・テーブルの存在を検証（例 `?select=<新列>&limit=0` が200か）。異常なら停止。

6. ★Merge承認ゲート（Mergeタイミング承認制・CC実行可）:
   - **`auto-on-merge` の場合：Merge＝{{DEPLOY_PLATFORM}} 自動デプロイ＝本番反映**。**`manual-cli` の場合：Merge はコードを `{{PROD_BRANCH}}` に入れるだけ**（本番反映は手順7）。いずれも **人が「今Mergeして」等を明示した時だけ** CC が実行。
   - 停止直前に：`node scripts/notify-humanball.mjs --kind ship承認 --task "<PRタイトル>" --detail "Mergeタイミング待ち/A.「今Mergeして」で実行 B.まだ／推奨A（<PR URL>）" [--url "<セッションurl>"]`
   - 人が「今Mergeして」等 → `gh pr merge <PR番号> --merge`。Merge後 `git fetch origin {{PROD_BRANCH}}`。

7. ★本番デプロイ承認ゲート（**`{{DEPLOY_TRIGGER}}=manual-cli` の時のみ**・人承認後CC実行）:
   - **`auto-on-merge` の場合はこの手順をスキップ**（手順6の Merge で本番反映済み）。
   - **`manual-cli` の場合＝本番反映はここ**。**人が「deployして」等を明示した時だけ** CC が `{{DEPLOY_CMD}}`（例 `vercel --prod --scope <scope>`・CLAUDE.md「Pipeline設定」記載）を実行する。**migration（手順5）が適用済みであることを確認してから**実行。
   - 停止直前に：`node scripts/notify-humanball.mjs --kind ship承認 --task "<PRタイトル>" --detail "本番デプロイ待ち/A.「deployして」で {{DEPLOY_CMD}} 実行 B.保留／推奨A（migration適用済）" [--url "<セッションurl>"]`
   - 実行後、デプロイURL/結果を表示。失敗時は停止して報告。
   - **edge functions / 別途反映が要る場合のみ**（Supabase edge functions を使うプロジェクト＝APP_LAYOUT_NOTES 参照。API route handlers のみのプロジェクトは不要）：★承認 → 本番refへ 1つずつ deploy。停止直前に通知。

8. スモーク（自動・本番URL `{{PROD_URL}}`）: リスク別の手数（前提§）で確認し報告。
   - **必ずハードリロード**（Cmd/Ctrl+Shift+R 相当）。デプロイ直後は旧バンドルがキャッシュされ、ハードリロードしないと誤判定する。
   - **ベース（全リスク）**：`GET {{PROD_URL}}/` → 200・描画・JSエラー無し。ログイン→主要画面表示。
   - **認可ガード疎通（既定・実送信ゼロで安全）**：外部 webhook / cron 等（APP_LAYOUT_NOTES の該当エンドポイント）を **署名/secret 無しで叩き 401/400**（ガードが効いている＝実バッチ/実配信を発火させない）。
   - **実機能スモーク（🔴高/🧱土台かつ明示時のみ・自テナント自分宛・隔離）**：外部送信（LINE/メール/push/決済）を**自分宛・隔離**で。他テナント・実顧客への配信は絶対にしない。確認後 cleanup。
   - 異常があれば即停止して報告。
   - 異常なければ：対象の本番待ちタスクのNotionステータスを「完了」に更新（完了日も入れる。REST PATCH で更新し再確認）。

9. 自走再開（スモーク異常なし & 人ボール残なし & Notion完了まで終わったら）:
   - 続けて /run のループに入り、次のdev作業を自走再開する。
   - 異常・人ボール待ちが残る場合はここで停止して報告（/run には入らない）。

# §緊急hotfix独立ship（`hotfix/*`・`{{PROD_BRANCH}}`派生・dev堆積と無関係に出す）

/run 緊急レーンが作った本番待ち（📋に「緊急hotfix・ブランチ=`hotfix/<slug>`」と記載・ローカルに `hotfix/*` あり）を、**dev を経由せず独立してshipする**：
1. プリフライト（手順1）＋ migrationチェック（手順2）＋ RLS監査（手順2.5）＋ 独立AIレビュー（手順4.5。緊急でも🔴は `--runs 3`）。block/🔴LEAK は HALT。
2. **push**：`git push origin hotfix/<slug>`。
3. **PR作成**：`gh pr create --base {{PROD_BRANCH}} --head hotfix/<slug> --title "hotfix: <要約>" --body "<緊急理由／migration有無／RLS・独立レビュー結果／スモーク観点>"`。
4. **★migration適用**（追加のみ・手順5・本番反映前）。
5. **★Merge承認**（手順6・人の「今Mergeして」で `gh pr merge`）。
6. **★本番デプロイ**（`manual-cli` のみ手順7・人の「deployして」で `{{DEPLOY_CMD}}`。`auto-on-merge` は手順5の Merge で反映済み）。
7. **スモーク**（手順8・緊急は🔴相当で実機能まで・自分宛隔離）。

厳守:

- **`{{PROD_BRANCH}}` へ直接 push しない**。Merge は **人がタイミングを明示承認した時のみ** CCが `gh pr merge`（未指定なら待機）。
- **`manual-cli` の本番デプロイ（`{{DEPLOY_CMD}}`）は人の明示承認後にのみ** CC が実行。`auto-on-merge` は Merge承認＝デプロイ。migration（追加のみ）適用は本番反映より前。
- migration適用 / Merge / 本番デプロイ は必ず人の承認を取る。承認なしに実行しない。
- **migration適用は「追加のみDDL」に限る。破壊的を1つでも含むならCCは適用せず、人手＋事前バックアップを促して停止**。
- **RLS監査(2.5)で🔴LEAK・独立AIレビュー(4.5)で verdict=block の間は本番反映に進まない**（HALT・`ship-blocked`）。pass でも本番反映は人間の confirm 後（`ship-ready`）。kind を `ship承認` と混線させない。
- preview は使わない。品質担保はローカルE2E全green＋独立AIレビュー＋RLS監査＋本番スモーク（**ハードリロード必須**）。
- supabase db push は絶対にしない。`SUPABASE_PROD_DB_URL` の値はログ/チャットに残さない。
- **本番スモークの外部送信は🔴時のみ・自テナント自分宛・隔離**。通常は認可ガード疎通（401/400）で実送信ゼロ。他テナント・実顧客への配信は絶対にしない。
- **停止＝LINE通知（例外なし）**：人の承認待ちで止まる時は直前に必ず notify-humanball.mjs（best-effort）。提示・`--detail` は CLAUDE.md「人ボール報告フォーマット（必須）」（結論先頭・A/B・推奨1行、LINE は1〜2行）に従う。
- スモークで異常があれば即停止して報告。
- .env はコミットしない。

---

## Phase 5 改修（2026-07-24）— ロールバック先確保・時間帯プロンプト・osarAI再検討
- **起動後は本番反映まで一括（T14）**: /ship 起動＝人がタイミングを承認した文脈。T14#1 の範囲（追加のみmigration・CI経由deploy・可逆Merge・verdict=pass）は再承認を求めず自動で進む。T14#2（破壊的/不可逆/secret値）は停止＋通知。
- **ロールバック手順を先に確保**: 本番反映の**前に**切り戻し手順（前タグ/前デプロイへの復帰・migration の逆手順の有無）を明示し、確保できなければ進めない。
- **確認できない時間帯はプロンプト**: 本人が即応できない時間帯（深夜等）の本番反映は、実行前に「今進めてよいか」をプロンプトで確認する。
- **osarAI 非配置理由の解消を再検討（メモ）**: osarAI に ship.md を置かない理由は「本番リリース基盤未確立」。基盤が整い次第、配置を再検討する（現状は非配置維持）。
- 摩擦は `log-friction.mjs`（型・発生元=/ship）。
