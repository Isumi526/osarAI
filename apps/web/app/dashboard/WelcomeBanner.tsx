'use client';

// Stripe Checkout完了後 (?welcome=1) にトライアル開始を明示するバナー。
// 表示後はクエリを除去し、リロード/再訪では出ない（1回限り）。
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export function WelcomeBanner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (searchParams.get('welcome') === '1') {
      setShow(true);
      router.replace('/dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!show) return null;

  return (
    <div
      style={{
        background: 'var(--color-primary-light)',
        border: '1px solid var(--color-primary-border)',
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>✅ 14日間無料トライアルを開始しました！</p>
    </div>
  );
}
