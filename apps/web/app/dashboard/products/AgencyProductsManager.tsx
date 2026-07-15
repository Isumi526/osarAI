'use client';

// 代理店(leader)が商品リストを作成・削除するクライアント側UI。
// /api/agency-products 経由でCRUDする(apps/web/app/billing/BillingPortalButton.tsxと同じ
// API route + cookieセッション認証のパターンに統一)。
import { useState } from 'react';

interface AgencyProduct {
  id: string;
  name: string;
  price: string | null;
  appeal: string | null;
  target: string | null;
}

export function AgencyProductsManager({ initialProducts }: { initialProducts: AgencyProduct[] }) {
  const [products, setProducts] = useState(initialProducts);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [appeal, setAppeal] = useState('');
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await fetch('/api/agency-products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, price, appeal, target }),
    });
    const data = (await res.json()) as { product?: AgencyProduct; error?: string };
    setSaving(false);
    if (!res.ok || !data.product) {
      setError(data.error ?? '追加に失敗しました。');
      return;
    }
    setProducts((ps) => [...ps, data.product!]);
    setName('');
    setPrice('');
    setAppeal('');
    setTarget('');
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/agency-products/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? '削除に失敗しました。');
      return;
    }
    setProducts((ps) => ps.filter((p) => p.id !== id));
  }

  return (
    <div>
      <form onSubmit={onAdd} style={{ display: 'grid', gap: 8, marginBottom: 24, maxWidth: 480 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="商品名（例: がん保険）" style={{ padding: 10 }} />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="金額（例: 月々3,000円〜）" style={{ padding: 10 }} />
        <textarea value={appeal} onChange={(e) => setAppeal(e.target.value)} placeholder="魅力・概要" rows={2} style={{ padding: 10 }} />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="ターゲット・届けたい相手" style={{ padding: 10 }} />
        <button type="submit" disabled={saving} style={{ padding: 12 }}>
          {saving ? '追加中…' : '+ 商品を追加'}
        </button>
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
      </form>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--color-border)' }}>
            <th style={th}>商品名</th>
            <th style={th}>金額</th>
            <th style={th}>魅力・概要</th>
            <th style={th}>ターゲット・届けたい相手</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {products.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ ...td, color: '#9a9183' }}>
                まだ商品がありません。
              </td>
            </tr>
          ) : (
            products.map((p) => (
              <tr key={p.id} style={{ borderBottom: '1px solid #efeae0' }}>
                <td style={td}>{p.name}</td>
                <td style={td}>{p.price ?? '—'}</td>
                <td style={td}>{p.appeal ?? '—'}</td>
                <td style={td}>{p.target ?? '—'}</td>
                <td style={td}>
                  <button onClick={() => onDelete(p.id)} style={{ padding: '4px 10px', background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}>
                    削除
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: '#6b6358' };
const td: React.CSSProperties = { padding: '10px', fontSize: 14 };
