# プッシュ通知セットアップ手順（§12・FCM HTTP v1）

おさらい促し通知を実機に届けるための手順。**コード側は実装済み**（`apps/web/lib/push-fcm.ts` = FCM HTTP v1、`apps/mobile/src/lib/push.ts` = トークン登録、`/api/push/remind` = 送信）。
残りはコンソール設定と実機ビルド（人の作業）。

## 0. 前提
- bundle id（appId）= `ai.osarai.app`（`apps/mobile/capacitor.config.ts`）
- 実機（iOS/Android）と Xcode / Android Studio
- Apple Developer 登録（iOS配信に必須）

## 1. Firebase プロジェクト
1. https://console.firebase.google.com でプロジェクト作成（例: `osarai`）
2. **サーバー鍵（送信用・FCM v1）**：プロジェクト設定 → サービスアカウント → 「新しい秘密鍵を生成」→ JSON をDL
   - `.env` に設定（サーバーのみ・base64 か生JSON）：
     ```
     FCM_SERVICE_ACCOUNT=<DLしたJSONの中身 or base64>
     ```
   - base64 で入れる例（改行事故を避けられる）：`base64 -i service-account.json | pbcopy`

## 2. Android（FCM）
1. Firebase → アプリを追加 → Android、パッケージ名 `ai.osarai.app`
2. `google-services.json` をDL → `apps/mobile/android/app/google-services.json` に配置
3. ネイティブ生成（未生成なら）：
   ```
   pnpm --filter @osarai/mobile build       # dist を作る
   pnpm --filter @osarai/mobile exec cap add android
   pnpm --filter @osarai/mobile exec cap sync android
   ```
4. Android Studio で実機ビルド → 起動

## 3. iOS（APNs 経由 FCM）
1. Firebase → アプリを追加 → iOS、bundle id `ai.osarai.app` → `GoogleService-Info.plist` をDL
2. Apple Developer で **APNs認証キー(.p8)** を作成 → Firebase → プロジェクト設定 → Cloud Messaging → Apple アプリ構成 に .p8 / Key ID / Team ID を登録
3. ネイティブ生成：
   ```
   pnpm --filter @osarai/mobile exec cap add ios
   pnpm --filter @osarai/mobile exec cap sync ios
   ```
4. Xcode で `GoogleService-Info.plist` を追加、Signing 設定、**Push Notifications / Background Modes(Remote notifications)** capability を有効化 → 実機ビルド

## 4. 動作確認
1. 実機アプリ → 設定 → 「通知をオンにする」（`enablePush`）→ 許可
   - `push_tokens` にトークンが入る（Supabase で確認）
2. 送信テスト：ログイン中のユーザーの access_token で
   ```
   curl -X POST https://<web>/api/push/remind -H "authorization: Bearer <token>"
   ```
   → レスポンス `{tokens, configured:true, sent, failed}`。`sent>=1` かつ実機に「おさらいしませんか？」が届けば OK。
   - `configured:false` = `FCM_SERVICE_ACCOUNT` 未設定。

## 5. 将来
- 一括リマインド（予定/活動を入れた人・1日の終わり）は cron から `/api/push/remind` 相当を叩く形に拡張（現状は本人テスト送信）。
