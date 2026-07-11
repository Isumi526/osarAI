/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // モノレポの shared パッケージをトランスパイル対象にする
  transpilePackages: ['@osarai/shared'],
  // E2E用にlocal Supabase向けの別インスタンスを同時起動する時、.next を共有すると
  // ビルドキャッシュが競合破損する（2つのnext devが同時書き込み）。distDirを分離する。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  experimental: {
    // /api/transcribe は音声をbase64 JSONで受ける。既定10MBだとbase64化(約1.33倍)で
    // 数分の録音でも上限に触れ、req.json()が壊れたJSONとして例外を投げ500になる
    // （transcribe/route.tsの意図的な413チェックより先に落ちてしまう）。
    // アプリ側の上限(25MB生データ)が先に効くよう、余裕を持って引き上げる。
    middlewareClientMaxBodySize: 40 * 1024 * 1024,
  },
};

export default nextConfig;
