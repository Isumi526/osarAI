/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // モノレポの shared パッケージをトランスパイル対象にする
  transpilePackages: ['@osarai/shared'],
  // E2E用にlocal Supabase向けの別インスタンスを同時起動する時、.next を共有すると
  // ビルドキャッシュが競合破損する（2つのnext devが同時書き込み）。distDirを分離する。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
