// 顧客の新規作成／編集フォーム。/customers/new と /customers/:id/edit。
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createCustomer,
  updateCustomer,
  getCustomer,
  getMyProfile,
  type CustomerInput,
} from '../lib/db.js';
import type { CustomerStatus, Temperature } from '@osarai/shared';

const TEMPS: Temperature[] = ['hot', 'warm', 'cold'];
const TEMP_LABEL: Record<Temperature, string> = { hot: '🔥 hot', warm: '☀️ warm', cold: '❄️ cold' };

export function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [temperature, setTemperature] = useState<Temperature | null>(null);
  const [needs, setNeeds] = useState('');
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    getCustomer(id)
      .then((c) => {
        if (!c) return;
        setName(c.name);
        setTemperature((c.temperature as Temperature | null) ?? null);
        setNeeds(c.needs ?? '');
        setStatus(c.status as CustomerStatus);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: CustomerInput = { name, temperature, needs: needs || null, status };
    try {
      if (isEdit && id) {
        await updateCustomer(id, input);
        navigate(`/customers/${id}`);
      } else {
        const profile = await getMyProfile();
        if (!profile) throw new Error('プロフィールが取得できません');
        const created = await createCustomer(input, profile);
        navigate(`/customers/${created.id}`);
      }
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  if (loading) return <main className="screen">読み込み中…</main>;

  return (
    <main className="screen">
      <h1>{isEdit ? '顧客を編集' : '新しい顧客'}</h1>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
        <label>
          名前
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{ width: '100%', padding: 10, fontSize: 16 }}
          />
        </label>

        <div>
          温度感
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {TEMPS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTemperature(temperature === t ? null : t)}
                style={{
                  flex: 1,
                  padding: 10,
                  border: temperature === t ? '2px solid #c9a24b' : '1px solid #d9d3c8',
                  background: temperature === t ? '#fdf6e6' : '#fff',
                  borderRadius: 8,
                }}
              >
                {TEMP_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        <label>
          ニーズ・メモ
          <textarea
            value={needs}
            onChange={(e) => setNeeds(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 10, fontSize: 16 }}
          />
        </label>

        <label>
          ステータス
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as CustomerStatus)}
            style={{ width: '100%', padding: 10, fontSize: 16 }}
          >
            <option value="active">対応中</option>
            <option value="archived">アーカイブ</option>
          </select>
        </label>

        {error && <p style={{ color: '#c0392b' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => navigate(-1)} style={{ flex: 1, padding: 12 }}>
            キャンセル
          </button>
          <button type="submit" disabled={saving} style={{ flex: 2, padding: 12, fontSize: 16 }}>
            {saving ? '...' : '保存'}
          </button>
        </div>
      </form>
    </main>
  );
}
