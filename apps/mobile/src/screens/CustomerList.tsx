// つながり一覧。2026-08-06 のUI/UX刷新でホーム画面から切り出した独立ページ。
// ホームはダッシュボード＋AIチャット入口に専念し、一覧はマイページ配下から辿る。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCustomers, RELATION_TYPES, type Customer } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { TempIcon } from '../components/TempIcon.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import type { Temperature } from '@osarai/shared';

// つながりの区分バッジの色。温度感の危険色(--color-danger)とは重ならない淡い配色にする。
const RELATION_BADGE_STYLE: Record<(typeof RELATION_TYPES)[number], { background: string; color: string }> = {
  つながり: { background: '#f1efe9', color: 'var(--color-text-muted)' },
  顧客: { background: 'var(--color-primary-light)', color: 'var(--color-primary-dark)' },
  パートナー: { background: '#e6f2ea', color: 'var(--color-success)' },
};

export function CustomerList() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const filtered = searchQuery.trim()
    ? customers.filter((c) => c.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : customers;

  useEffect(() => {
    let active = true;
    setLoading(true);
    listCustomers({ status: 'active' })
      .then((rows) => active && setCustomers(rows))
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    getEntitlement()
      .then((e) => setSubActive(e.active))
      .catch(() => setSubActive(true)); // 取得失敗時はブロックしない（APIが最終ゲート）
  }, []);

  return (
    <main className="screen">
      <ScreenHeader>
        <Link to="/settings">← マイページ</Link>
        <strong>つながり一覧</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {!loading && customers.length > 0 && (
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="名前で検索"
          style={{ width: '100%', padding: 10, fontSize: 15, margin: '12px 0 8px' }}
        />
      )}
      {loading ? (
        <p>読み込み中…</p>
      ) : customers.length === 0 ? (
        <p style={{ color: '#6b6358', marginTop: 16 }}>
          まだつながりがいません。ホームの「AIと話す」から、会った人のことを話すと登録できます。
        </p>
      ) : filtered.length === 0 ? (
        <p style={{ color: '#6b6358' }}>「{searchQuery}」に一致するつながりが見つかりません。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {filtered.map((c) => (
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
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {c.temperature ? <TempIcon value={c.temperature as Temperature} /> : null}
                  {c.name}
                  <span style={{ fontSize: 12 }}>さん</span>
                  {c.relation_type && (
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 6,
                        ...RELATION_BADGE_STYLE[c.relation_type as (typeof RELATION_TYPES)[number]],
                      }}
                    >
                      {c.relation_type}
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '50%' }}>
                  {c.needs && (
                    <span style={{ color: '#9a9183', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.needs}
                    </span>
                  )}
                  {c.last_met_at && (
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {new Date(c.last_met_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={() => navigate('/customers/new')}
        disabled={!subActive}
        aria-label="つながりを追加"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 'calc(56px + env(safe-area-inset-bottom) + 16px)',
          width: 56,
          height: 56,
          borderRadius: '50%',
          fontSize: 28,
          lineHeight: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          zIndex: 90,
        }}
      >
        ＋
      </button>
    </main>
  );
}
