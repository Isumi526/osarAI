'use client';

import { useState } from 'react';
import { PLANS, type PlanId } from '@osarai/shared';
import { Spinner } from '@/components/Spinner';

// phase1はStandard単一プランのみ表示(Light/Proはphase2以降)。
// PLANS定義・Stripe Price・checkout APIは変更せず、UIの選択肢のみ絞る。
const ORDER: PlanId[] = ['standard'];

export function PlanPicker({ code }: { code: string | null }) {
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(plan: PlanId) {
    setLoading(plan);
    setError(null);
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, promoCode: code ?? undefined }),
    });
    const data = (await res.json()) as { url?: string; error?: string };
    if (data.url) {
      window.location.href = data.url;
    } else {
      setError(data.error ?? 'checkout に失敗しました');
      setLoading(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      {ORDER.map((id) => {
        const p = PLANS[id];
        const recommended = id === 'standard';
        return (
          <div
            key={id}
            style={{
              border: recommended ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
              borderRadius: 12,
              padding: 20,
              background: '#fff',
            }}
          >
            <h2 style={{ margin: '0 0 4px' }}>{p.name}</h2>
            {recommended && <p style={{ color: 'var(--color-primary)', margin: '0 0 8px' }}>おすすめ</p>}
            <p style={{ fontSize: 24, margin: '0 0 12px' }}>¥{p.listPrice.toLocaleString()}/月</p>
            <ul style={{ paddingLeft: 18, fontSize: 14, color: '#6b6358' }}>
              <li>AI相談: {p.aiAdviceLimit === null ? '無制限' : `月${p.aiAdviceLimit}回`}</li>
              <li>録音取り込み: {p.recordingImport ? '○' : '×'}</li>
              <li>リーダー集約: {p.leaderDashboard ? '○' : '×'}</li>
            </ul>
            <button
              onClick={() => choose(id)}
              disabled={loading !== null}
              style={{ width: '100%', padding: 12, fontSize: 16, marginTop: 8 }}
            >
              {loading === id ? <Spinner /> : '14日無料で始める'}
            </button>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
              トライアル期間中にキャンセルすれば料金はかかりません。
            </p>
          </div>
        );
      })}
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
    </div>
  );
}
