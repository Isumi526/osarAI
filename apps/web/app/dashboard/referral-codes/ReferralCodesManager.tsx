'use client';

// 代理店(leader)の紹介コード管理UI。/api/referral-codes 経由でCRUDする。
import { useState } from 'react';

interface ReferralCode {
  id: string;
  code: string;
  label: string | null;
  signupCount: number;
}

export function ReferralCodesManager({ initialCodes }: { initialCodes: ReferralCode[] }) {
  const [codes, setCodes] = useState(initialCodes);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await fetch('/api/referral-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label }),
    });
    const data = (await res.json()) as { referralCode?: ReferralCode; error?: string };
    setSaving(false);
    if (!res.ok || !data.referralCode) {
      setError(data.error ?? '追加に失敗しました。');
      return;
    }
    setCodes((cs) => [...cs, data.referralCode!]);
    setCode('');
    setLabel('');
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/referral-codes/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? '削除に失敗しました。');
      return;
    }
    setCodes((cs) => cs.filter((c) => c.id !== id));
  }

  return (
    <div>
      <form onSubmit={onAdd} style={{ display: 'grid', gap: 8, marginBottom: 24, maxWidth: 480 }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="コード（例: LL2026）" style={{ padding: 10 }} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="メモ（例: リベラルライフ福利厚生価格）" style={{ padding: 10 }} />
        <button type="submit" disabled={saving} style={{ padding: 12 }}>
          {saving ? '追加中…' : '+ コードを記録'}
        </button>
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
      </form>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--color-border)' }}>
            <th style={th}>コード</th>
            <th style={th}>メモ</th>
            <th style={{ ...th, textAlign: 'right' }}>このコード経由の登録者数</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {codes.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ ...td, color: '#9a9183' }}>
                まだ記録されたコードがありません。
              </td>
            </tr>
          ) : (
            codes.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #efeae0' }}>
                <td style={td}>{c.code}</td>
                <td style={td}>{c.label ?? '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{c.signupCount}</td>
                <td style={td}>
                  <button onClick={() => onDelete(c.id)} style={{ padding: '4px 10px', background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}>
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
