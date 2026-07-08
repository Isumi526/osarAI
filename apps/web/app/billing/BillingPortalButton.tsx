'use client';

import { useState } from 'react';

export function BillingPortalButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setLoading(true);
    setError(null);
    const res = await fetch('/api/stripe/portal', { method: 'POST' });
    const data = (await res.json()) as { url?: string; error?: string };
    if (data.url) {
      window.location.href = data.url;
    } else {
      setError(data.error ?? 'お支払い管理画面を開けませんでした。');
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={openPortal} disabled={loading} style={{ padding: 12, fontSize: 16 }}>
        {loading ? '...' : 'お支払い方法を更新する'}
      </button>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
    </div>
  );
}
