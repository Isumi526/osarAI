// Home（顧客リスト＋フィルタ＋おさらい導線）。§10。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCustomers, getMyProfile, type Customer } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { getPersonalStats, type PersonalStats } from '../lib/stats.js';
import { TempIcon } from '../components/TempIcon.js';
import type { CustomerStatus, Temperature } from '@osarai/shared';

const SELF_INTRO_PROMPTED_KEY = 'osarai_self_intro_prompted';

export function Home() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [temp, setTemp] = useState<Temperature | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(true); // 判定前は制限を出さない
  const [stats, setStats] = useState<PersonalStats | null>(null);

  useEffect(() => {
    getPersonalStats()
      .then(setStats)
      .catch(() => undefined); // 集計失敗はダッシュボード非表示に留め、画面全体は壊さない
  }, []);

  // 初回ログイン(この端末で未案内 かつ プロフィール未登録)なら「自分をおさらいする」へ誘導。
  // localStorageフラグで一度きり。スキップは self-osarai の戻るで可能。
  useEffect(() => {
    if (localStorage.getItem(SELF_INTRO_PROMPTED_KEY)) return;
    getMyProfile()
      .then((p) => {
        const up = (p?.user_profile as Record<string, unknown> | null) ?? {};
        const empty = Object.keys(up).length === 0;
        localStorage.setItem(SELF_INTRO_PROMPTED_KEY, '1');
        if (empty) navigate('/self-osarai');
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    getEntitlement()
      .then((e) => setSubActive(e.active))
      .catch(() => setSubActive(true)); // 取得失敗時はブロックしない（APIが最終ゲート）
  }, []);

  return (
    <main className="screen">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>osarAI</h1>
        <Link to="/settings">設定</Link>
      </header>

      {!subActive && (
        <div
          style={{
            background: '#fff7ed',
            border: '1px solid #f0d9b5',
            borderRadius: 10,
            padding: 12,
            margin: '12px 0',
            fontSize: 13,
            color: '#8a6d3b',
          }}
        >
          ご利用にはお申し込みが必要です。登録・プラン変更はWebから行えます（14日無料トライアル）。
        </div>
      )}

      {stats && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
            margin: '12px 0',
          }}
        >
          {[
            { label: '今月のアポ', value: stats.monthAppointments },
            { label: '今月のおさらい', value: stats.monthOsarai },
            { label: '累計アポ', value: stats.totalAppointments },
            { label: '累計おさらい', value: stats.totalOsarai },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: '#fff',
                border: '1px solid var(--color-border)',
                borderRadius: 10,
                padding: 10,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-primary)' }}>{s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button
          onClick={() => navigate('/osarai')}
          disabled={!subActive}
          style={{ flex: 1, padding: 12, fontSize: 15 }}
        >
          ＋ おさらいする
        </button>
        <button
          onClick={() => navigate('/chat')}
          disabled={!subActive}
          style={{ flex: 1, padding: 12, fontSize: 15 }}
        >
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
          <option value="hot">hot</option>
          <option value="warm">warm</option>
          <option value="cold">cold</option>
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
                  border: '1px solid var(--color-border)',
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span>
                  {c.temperature ? <TempIcon value={c.temperature as Temperature} /> : null} {c.name}
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
