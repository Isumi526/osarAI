// 顧客の新規作成／編集フォーム。/customers/new と /customers/:id/edit。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  createCustomer,
  updateCustomer,
  getCustomer,
  getMyProfile,
  RELATION_TYPES,
  DEFAULT_RELATION_TYPE,
  type CustomerInput,
} from '../lib/db.js';
import { analyzeCustomerText, analyzeCustomerImage } from '../lib/customerAnalyze.js';
import { TempIcon, TEMP_JA } from '../components/TempIcon.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import type { Temperature } from '@osarai/shared';

const TEMPS: Temperature[] = ['hot', 'warm', 'cold'];

export function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [relationType, setRelationType] = useState<string>(DEFAULT_RELATION_TYPE);
  const [temperature, setTemperature] = useState<Temperature | null>(null);
  const [needs, setNeeds] = useState('');
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
        setRelationType((c.relation_type as string | null) ?? DEFAULT_RELATION_TYPE);
        setTemperature((c.temperature as Temperature | null) ?? null);
        setNeeds(c.needs ?? '');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: CustomerInput = { name, temperature, needs: needs || null, relationType };
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
            background: '#fff',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
          }}
        >
          <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14 }}>登録方法を選べます</p>
          {/* つながりAI登録: まだ関係が浅い相手はテキスト、関係がある相手はAI対話がおすすめ。
              AI対話登録は既存の顧客おさらい(顧客未指定→完了時に新規カード生成)フローを流用する。 */}
          <button
            type="button"
            onClick={() => navigate('/osarai')}
            style={{ width: '100%', padding: 12, fontSize: 14, marginTop: 4 }}
          >
            AIと対話して登録する（つながりAI登録）
          </button>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
            すでに関係性がある人・何度か話したことがある人におすすめ。AIがどんな人かを深掘って聞いてくれます。
          </p>
        </section>
      )}

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
            テキスト・画像から登録（つながりテキスト登録・任意）
          </p>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-muted)' }}>
            まだ話したことがない・知り合ったばかりの相手におすすめ。
          </p>
          <AutoResizeTextarea
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

        <label>
          区分
          <select
            value={relationType}
            onChange={(e) => setRelationType(e.target.value)}
            style={{ width: '100%', padding: 10, fontSize: 16, marginTop: 4 }}
          >
            {RELATION_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </select>
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
          <AutoResizeTextarea
            value={needs}
            onChange={(e) => setNeeds(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 10, fontSize: 16 }}
          />
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
