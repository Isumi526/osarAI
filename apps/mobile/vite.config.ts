import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 実機（iPhone）検証用の一時公開（2026-09-22）。
// iOS はマイクに HTTPS を要求するので localhost では検証できない。ngrok で 1 本だけ
// トンネルを張り、API(web:3055) と Supabase(54321) はこの dev サーバーの proxy 経由に
// 寄せる＝すべて同一オリジンにする。トンネルを複数張ると ngrok の警告ページが
// XHR に返って通信が壊れるため、入口は必ず 1 本にする。
// 使い方: TUNNEL_HOST=xxxx.ngrok-free.app pnpm dev:mobile → ngrok http 5175
const tunnelHost = process.env.TUNNEL_HOST;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // Capacitor 実機ライブリロード用に LAN 公開
    ...(tunnelHost
      ? {
          allowedHosts: [tunnelHost],
          // 公開ホスト越しでも HMR が張れるように（wss で同じホストへ）
          hmr: { protocol: 'wss', host: tunnelHost, clientPort: 443 },
          proxy: {
            '/api': { target: 'http://localhost:3055', changeOrigin: true },
            // Supabase は /sb 配下にぶら下げる（VITE_SUPABASE_URL=https://<host>/sb）
            '/sb': {
              target: 'http://127.0.0.1:54321',
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/sb/, ''),
              ws: true,
            },
          },
        }
      : {}),
  },
});
