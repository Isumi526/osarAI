// 顧客の新規作成／編集フォーム。/customers/new と /customers/:id/edit。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createCustomer,
  updateCustomer,
  getCustomer,
  getMyProfile,
  type CustomerInput,
} from '../lib/db.js';
import { analyzeCustomerText, analyzeCustomerImage } from '../lib/customerAnalyze.js';
import { TempIcon, TEMP_JA } from '../components/TempIcon.js';
import type { CustomerStatus, Temperature } from '@osarai/shared';

const TEMPS: Temperature[] = ['hot', 'warm', 'cold'];

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

  // AI解析（紹介文/自己紹介シート画像→顧客カード初期値）。新規登録時のみ。
  const [analyzeText, setAnalyzeText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const analyzeFileRef = useRef<HTMLInputElement>(null);

  async function onAnalyzeText() {
    if (!analyzeText.trim() || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = await analyzeCustomerText(analyzeText);
      if (r.name) setName(r.name);
      if (r.needs) setNeeds(r.needs);
      if (r.temperature) setTemperature(r.temperature);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function onAnalyzeImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (analyzeFileRef.current) analyzeFileRef.current.value = '';
    if (!file || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = await analyzeCustomerImage(file);
      if (r.name) setName(r.name);
      if (r.needs) setNeeds(r.needs);
      if (r.temperature) setTemperature(r.temperature);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAnalyzing(false);
    }
  }

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

      {!isEdit && (
        <section
          style={{
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 14 }}>
            AIで解析して入力（任意）
          </p>
          <textarea
            value={analyzeText}
            onChange={(e) => setAnalyzeText(e.target.value)}
            placeholder="紹介文や自己紹介の文面を貼り付け…"
            rows={3}
            disabled={analyzing}
            style={{ width: '100%', padding: 10, fontSize: 14 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={onAnalyzeText}
              disabled={analyzing || !analyzeText.trim()}
              style={{ flex: 1, padding: 10, fontSize: 14 }}
            >
              {analyzing ? '解析中…' : 'テキストから解析'}
            </button>
            <button
              type="button"
              onClick={() => analyzeFileRef.current?.click()}
              disabled={analyzing}
              style={{ flex: 1, padding: 10, fontSize: 14 }}
            >
              自己紹介シート画像から解析
            </button>
          </div>
          <input
            ref={analyzeFileRef}
            type="file"
            accept="image/*"
            onChange={onAnalyzeImage}
            style={{ display: 'none' }}
          />
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
            解析結果は下のフォームに反映されます。内容を確認・修正のうえ保存してください。
          </p>
        </section>
      )}

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
                  border: temperature === t ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                  background: temperature === t ? 'var(--color-primary-light)' : '#fff',
                  color: 'var(--color-text)',
                  borderRadius: 8,
                }}
              >
                <TempIcon value={t} /> {TEMP_JA[t]}
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

        {isEdit && (
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
        )}

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
