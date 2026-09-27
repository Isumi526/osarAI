// 顧客の新規作成／編集フォーム。/customers/new と /customers/:id/edit。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  createCustomer,
  updateCustomer,
  getCustomer,
  getMyProfile,
  DEFAULT_RELATION_TYPE,
  type CustomerInput,
} from '../lib/db.js';
import { analyzeCustomerText, analyzeCustomerImage } from '../lib/customerAnalyze.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import { RequiredMark } from '../components/RequiredMark.js';

export function CustomerForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 予定作成中にその場で名前だけ仮登録したつながりを、その場提案モーダルの
  // 「テキストで登録する」から本登録する専用フロー。isEditだが自己紹介解析UIを出す。
  const isRegisterFlow = searchParams.get('register') === '1';
  const showAnalyze = !isEdit || isRegisterFlow;

  const [name, setName] = useState('');
  const [relationType, setRelationType] = useState<string>(DEFAULT_RELATION_TYPE);
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
        setNeeds(c.needs ?? '');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: CustomerInput = { name, needs: needs || null, relationType };
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
      <h1>{isRegisterFlow ? 'つながりを追加' : isEdit ? 'つながりを編集' : '新しいつながり'}</h1>

      {/* 「AIと対話して登録する（つながりAI登録）」は旧おさらい対話への入口だったので外した（2026-09-27・
          機能を絞る人判断）。つながりは会議録音から自動で登録されるのが基本。 */}
      {showAnalyze && (
        <details
          style={{
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
          }}
        >
          {/* 任意の補助機能なので既定は閉じておく（まず名前とメモだけで登録できるように） */}
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>紹介文や自己紹介シートから入力する（任意）</summary>
          <p style={{ margin: '8px 0 8px', fontSize: 12, color: 'var(--color-text-muted)' }}>
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
        </details>
      )}

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
        <label>
          名前 <RequiredMark />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{ width: '100%', padding: 10, fontSize: 16 }}
          />
        </label>

        {/* 区分（relation_type）は画面から外した。既定値のまま保存される（DB の値は残る） */}
        <label>
          この人のメモ
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
