// Home（顧客リスト＋フィルタ＋おさらい導線）。§10。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCustomers, type Customer } from '../lib/db.js';
import type { CustomerStatus, Temperature } from '@osarai/shared';

const TEMP_LABEL: Record<Temperature, string> = { hot: '🔥', warm: '☀️', cold: '❄️' };

export function Home() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [temp, setTemp] = useState<Temperature | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listCustomers({ status, temperature: temp || undefined })
      .then((rows) => active && setCustomers(rows))
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [status, temp]);

  return (
    <main className="screen">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>osarAI</h1>
        <Link to="/settings">設定</Link>
      </header>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button onClick={() => navigate('/osarai')} style={{ flex: 1, padding: 12, fontSize: 15 }}>
          ＋ おさらいする
        </button>
        <button onClick={() => navigate('/chat')} style={{ flex: 1, padding: 12, fontSize: 15 }}>
          AIに相談
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as CustomerStatus)}>
          <option value="active">対応中</option>
          <option value="archived">アーカイブ</option>
        </select>
        <select value={temp} onChange={(e) => setTemp(e.target.value as Temperature | '')}>
          <option value="">温度感: 全部</option>
          <option value="hot">🔥 hot</option>
          <option value="warm">☀️ warm</option>
          <option value="cold">❄️ cold</option>
        </select>
        <button onClick={() => navigate('/customers/new')} style={{ marginLeft: 'auto' }}>
          ＋顧客
        </button>
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {loading ? (
        <p>読み込み中…</p>
      ) : customers.length === 0 ? (
        <p style={{ color: '#6b6358' }}>
          まだ顧客がいません。「＋顧客」または「おさらいする」から追加できます。
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {customers.map((c) => (
            <li key={c.id}>
              <Link
                to={`/customers/${c.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  background: '#fff',
                  border: '1px solid #e7e1d6',
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span>
                  {c.temperature ? TEMP_LABEL[c.temperature as Temperature] : '　'} {c.name}
                </span>
                {c.needs && (
                  <span style={{ color: '#9a9183', fontSize: 13, maxWidth: '50%' }}>{c.needs}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
