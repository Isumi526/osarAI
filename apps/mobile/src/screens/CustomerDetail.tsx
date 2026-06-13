// CustomerDetail（カード＋タイムライン＝interactions時系列）。§9 F-01。
import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  getCustomer,
  listInteractions,
  deleteCustomer,
  type Customer,
  type Interaction,
} from '../lib/db.js';
import type { AiSummary, Temperature } from '@osarai/shared';

const TEMP_LABEL: Record<Temperature, string> = { hot: '🔥 hot', warm: '☀️ warm', cold: '❄️ cold' };
const SOURCE_LABEL: Record<string, string> = {
  ai_dialogue: 'AIおさらい',
  in_person_rec: '対面録音',
  zoom_rec: 'Zoom録画',
  manual: '手入力',
};

export function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([getCustomer(id), listInteractions(id)])
      .then(([c, ix]) => {
        setCustomer(c);
        setInteractions(ix);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  async function onDelete() {
    if (!id || !confirm('この顧客を削除しますか？（履歴も消えます）')) return;
    try {
      await deleteCustomer(id);
      navigate('/');
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) return <main className="screen">読み込み中…</main>;
  if (!customer) return <main className="screen">顧客が見つかりません。<Link to="/">戻る</Link></main>;

  return (
    <main className="screen">
      <Link to="/">← 一覧</Link>

      {/* 顧客カード */}
      <section
        style={{ background: '#fff', border: '1px solid #e7e1d6', borderRadius: 12, padding: 16, marginTop: 12 }}
      >
        <h1 style={{ margin: '0 0 8px' }}>{customer.name}</h1>
        <p style={{ margin: '4px 0' }}>
          温度感: {customer.temperature ? TEMP_LABEL[customer.temperature as Temperature] : '—'}
          {'　'}/ {customer.status === 'active' ? '対応中' : 'アーカイブ'}
        </p>
        {customer.needs && <p style={{ margin: '4px 0' }}>ニーズ: {customer.needs}</p>}
        {customer.last_met_at && (
          <p style={{ margin: '4px 0', color: '#9a9183', fontSize: 13 }}>
            最終接触: {new Date(customer.last_met_at).toLocaleDateString('ja-JP')}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => navigate(`/customers/${customer.id}/edit`)} style={{ flex: 1, padding: 10 }}>
            編集
          </button>
          <button onClick={onDelete} style={{ padding: 10, color: '#c0392b' }}>
            削除
          </button>
        </div>
      </section>

      {/* タイムライン */}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>タイムライン</h2>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {interactions.length === 0 ? (
        <p style={{ color: '#6b6358' }}>
          まだ履歴がありません。「おさらいする」や録音取り込みで追加されます。
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
          {interactions.map((ix) => {
            const summary = ix.ai_summary as AiSummary | null;
            const when = ix.met_at ?? ix.created_at;
            return (
              <li
                key={ix.id}
                style={{ background: '#fff', border: '1px solid #e7e1d6', borderRadius: 10, padding: 12 }}
              >
                <div style={{ fontSize: 12, color: '#9a9183' }}>
                  {new Date(when).toLocaleString('ja-JP')} ・ {SOURCE_LABEL[ix.source] ?? ix.source}
                </div>
                {summary?.points?.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {summary.points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ margin: '6px 0 0' }}>{ix.transcript ?? ix.raw_text ?? '（内容なし）'}</p>
                )}
                {summary?.next_actions?.length ? (
                  <p style={{ margin: '6px 0 0', color: '#2d7d46', fontSize: 13 }}>
                    次アクション: {summary.next_actions.join(' / ')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
