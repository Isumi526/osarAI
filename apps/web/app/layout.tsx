import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Nav } from './Nav';
import { NavGate } from './NavGate';

export const metadata: Metadata = {
  title: 'osarAI 〜おさらい〜',
  // 2026-09-27: 検索結果・共有時の説明も会議録音中心の訴求に揃える
  description: '忙しくても、人を大切にできる自分に。会う前に録音ボタンを押すだけで、議事録・次の予定・TODOをAIが残します。',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, 'Hiragino Sans', sans-serif",
          background: 'var(--color-bg)',
          color: 'var(--color-text)',
        }}
      >
        <NavGate>
          <Nav />
        </NavGate>
        {children}
      </body>
    </html>
  );
}
