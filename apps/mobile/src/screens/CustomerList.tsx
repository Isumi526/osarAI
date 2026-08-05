// つながり一覧。2026-08-06 のUI/UX刷新でホーム画面から切り出した独立ページ。
// ホームはダッシュボード＋AIチャット入口に専念し、一覧はマイページ配下から辿る。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCustomers, mergeCustomers, findDuplicateGroups, RELATION_TYPES, type Customer } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { TempIcon } from '../components/TempIcon.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useConfirm } from '../components/ConfirmDialog.js';
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
  const [merging, setMerging] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 表記揺れで二重登録されたつながりの候補（正規化名が一致する組）
  const duplicateGroups = findDuplicateGroups(customers);
  const filtered = searchQuery.trim()
    ? customers.filter((c) => c.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : customers;

  async function reload() {
    setLoading(true);
    try {
      setCustomers(await listCustomers({ status: 'active' }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // 重複候補をまとめる。履歴(interactions/予定/タスク)はサーバー側で統合先へ付け替わる。
  async function onMerge(group: Customer[]) {
    const [target, ...rest] = group;
    if (!target) return;
    const ok = await confirm(
      `「${target.name}」さんが${group.length}件に分かれて登録されています。1つにまとめますか？\n` +
        '会話履歴・予定・タスクはすべて残ります。',
    );
    if (!ok) return;
    setMerging(true);
    try {
      for (const src of rest) await mergeCustomers(src.id, target.id);
      await reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setMerging(false);
    }
  }

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

      {/* 同じ人が表記揺れで二重登録されている場合の統合導線（2026-08-06） */}
      {duplicateGroups.map((g) => (
        <div
          key={g[0]!.id}
          style={{
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            borderRadius: 10,
            padding: 12,
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 13,
          }}
        >
          <span>
            「{g[0]!.name}」さんが{g.length}件に分かれています
          </span>
          <button type="button" onClick={() => onMerge(g)} disabled={merging} style={{ padding: '6px 12px', fontSize: 13 }}>
            {merging ? '統合中…' : '1つにまとめる'}
          </button>
        </div>
      ))}

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
      {confirmDialog}
    </main>
  );
}
