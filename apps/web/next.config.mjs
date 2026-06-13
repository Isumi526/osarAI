/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // モノレポの shared パッケージをトランスパイル対象にする
  transpilePackages: ['@osarai/shared'],
};

export default nextConfig;
