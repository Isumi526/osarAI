import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'osarAI 〜おさらい〜',
  description: '忙しくても、人を大切にできる自分に。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
        {children}
      </body>
    </html>
  );
}
