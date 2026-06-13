import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.osarai.app',
  appName: 'osarAI',
  webDir: 'dist',
  // 実機ライブリロードは `server.url` を一時的に dev サーバへ向けて使う（提出時は外す）。
};

export default config;
