# osarAI 〜おさらい〜（モノレポ）

> 忙しくても、人を大切にできる自分に。
> 設計の正本：[`CLAUDE.md`](./CLAUDE.md)（詳細設計）＋ [`requirements_mvp.md`](./requirements_mvp.md)（要件）。

## 構成

```
apps/mobile      React (Vite) + Capacitor … おさらいアプリ（iOS/Android）
apps/web         Next.js (App Router)     … LP / サインアップ・課金 / リーダーDashboard / API
packages/shared  型・共通ロジック・AIプロンプト（mobile/web で共有）
supabase/        migrations（DDL+RLS） / functions（Edge Functions）
```

## セットアップ

```bash
pnpm install
cp .env.example .env   # 値は各自記入（§13）。.env はコミットしない

# 各アプリは自分のディレクトリの env を読む（Next=apps/web、Vite=apps/mobile）。
# ルート .env を単一ソースにしてシンボリックリンクで共有する：
ln -sf ../../.env apps/web/.env.local
ln -sf ../../.env apps/mobile/.env
```

> 秘匿値（service_role/Gemini/Stripe secret）は接頭辞なし＝サーバーのみ。
> クライアントに出るのは `NEXT_PUBLIC_` / `VITE_` 接頭辞の値だけ。

## 開発サーバ

```bash
pnpm dev:web      # Next.js  → http://localhost:3000
pnpm dev:mobile   # Vite     → http://localhost:5173
```

## 実装フェーズ（§14）

| # | 内容 | 状態 |
|---|------|------|
| 0 | 環境セットアップ（Supabase/Gemini/Stripe/GitHub） | 人間作業＋CLIスクリプト |
| 1 | **Scaffold（本コミット）** | ✅ |
| 2 | DB（DDL+RLS migration）＋型生成 | 未 |
| 3 | Auth（Supabase・組織/プロフィール） | 未 |
| 4 | 課金（Stripe Checkout・Webhook） | 未 |
| 5 | 顧客管理（Mobile） | 未 |
| 6 | おさらい対話（Mobile＋API）★コア | 未 |
| 7 | AI相談 | 未 |
| 8 | 録音取り込み（サブ） | 未 |
| 9 | リーダーDashboard（Web） | 未 |
| 10 | プッシュ通知 | 未 |
| 11 | 仕上げ＆DoD | 未 |

> スコープ外（Phase2：マッチング/フル音声/Zoom連携/ネイティブ録音/IAP）は実装しない（§2 OUT）。
