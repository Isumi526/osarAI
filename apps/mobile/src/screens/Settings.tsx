// Settings（プロフィール／通知許可）。※課金導線は置かない（§11 IAP回避）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { enablePush, isPushSupported } from '../lib/push.js';
import { getMyProfile, updateMyUserProfile } from '../lib/db.js';
import { AutoResizeTextarea } from '../components/AutoResizeTextarea.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';

// 目標・扱っている商品は複数登録できるよう別UI(goals/products)で扱うため、ここには含めない。
// 性別は選択式、経歴は自動リサイズのテキストエリア、他は単一行入力(議事録要望)。
const GENDER_OPTIONS = ['男性', '女性', 'その他', '回答しない'] as const;
const PROFILE_FIELDS: { key: string; label: string; type?: 'select' | 'textarea' }[] = [
  { key: 'age', label: '年齢' },
  { key: 'gender', label: '性別', type: 'select' },
  { key: 'background', label: '経歴', type: 'textarea' },
  { key: 'job', label: '仕事' },
];

type Goal = { text: string; by: string };
type Product = { name: string; price: string; appeal: string; target: string; audience: string };

export function Settings() {
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // AI戦略相談のコンテキストに使う自分のプロフィール
  const [userProfile, setUserProfile] = useState<Record<string, string>>({});
  const [goals, setGoals] = useState<Goal[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  // プロフィール項目(userProfile/goals)を未保存で編集中かどうか。BottomNav離脱時の確認ダイアログに使う。
  const [profileDirty, setProfileDirty] = useState(false);

  // 紹介コード（自分のprofiles.idから決定的に導出。別テーブル管理なし）
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        const raw = (p?.user_profile as Record<string, unknown> | null) ?? {};
        // goals/products(構造化)以外の自由記述フィールドだけを文字列マップとして取り出す。
        const { goals: rawGoals, goal: legacyGoal, products: rawProducts, ...rest } = raw as {
          goals?: Goal[];
          goal?: string;
          products?: Product[] | string;
          [k: string]: unknown;
        };
        const strFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rest)) if (typeof v === 'string') strFields[k] = v;
        setUserProfile(strFields);
        // 旧: 単一のgoal(文字列) → 新: goals配列へ移行。
        if (Array.isArray(rawGoals)) setGoals(rawGoals.filter((g) => g && typeof g.text === 'string'));
        else if (legacyGoal) setGoals([{ text: legacyGoal, by: '' }]);
        // 旧: 単一の自由記述文字列 → 新: products配列(名称/金額/購入条件)へ移行。
        if (Array.isArray(rawProducts)) setProducts(rawProducts.filter((x) => x && typeof x.name === 'string'));
        else if (typeof rawProducts === 'string' && rawProducts.trim()) {
          setProducts([{ name: rawProducts, price: '', appeal: '', target: '', audience: '' }]);
        }
        if (p) setReferralCode(p.id.replace(/-/g, '').slice(0, 12));
      })
      .catch(() => {});
  }, []);

  // 紹介リンクのベースURL。独自ドメイン確定後はVITE_LP_ORIGINを差し替えるだけで済む(回答C・env化)。
  // 未設定時はAPIベース(=Web/LPのオリジン)にフォールバック。
  const lpOrigin = (
    (import.meta.env.VITE_LP_ORIGIN as string | undefined) ??
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
    ''
  ).replace(/\/$/, '');
  const referralUrl = referralCode ? `${lpOrigin}/?ref=${referralCode}` : '';

  useRegisterNavGuard(profileDirty);

  async function onCopyReferralCode() {
    if (!referralUrl) return;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopyMsg('紹介リンクをコピーしました。');
    } catch {
      setCopyMsg(referralUrl); // クリップボードAPI非対応時はURL自体を表示
    }
  }

  async function onSaveProfile() {
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      // 空の目標行/商品行は保存しない。旧単一goal/products文字列は残さない(配列へ一本化)。
      const cleanGoals = goals.filter((g) => g.text.trim());
      const cleanProducts = products.filter((p) => p.name.trim());
      await updateMyUserProfile({ ...userProfile, goals: cleanGoals, products: cleanProducts });
      setProfileMsg('保存しました。');
      setProfileDirty(false);
    } catch (e) {
      setProfileMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setProfileSaving(false);
    }
  }

  async function onEnablePush() {
    setBusy(true);
    setPushMsg(null);
    try {
      const r = await enablePush();
      setPushMsg(
        r === 'granted'
          ? '通知をオンにしました。「おさらいしよう」のリマインドが届きます。'
          : r === 'denied'
            ? '通知が許可されませんでした。端末の設定から許可してください。'
            : 'この環境ではプッシュ通知は使えません（実機のみ）。',
      );
    } catch (e) {
      setPushMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <Link to="/">← ホーム</Link>
        <strong>マイページ</strong>
        <span style={{ width: 48 }} />
      </header>

      {referralCode && (
        <section
          style={{
            background: '#fff',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: 16,
            marginTop: 16,
          }}
        >
          <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>紹介コード</h2>
          <p style={{ margin: '0 0 12px', color: '#6b6358', fontSize: 14 }}>
            この紹介リンクを知り合いに送ると、そのリンクから登録した人があなたの紹介として記録されます。
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code
              style={{
                flex: 1,
                padding: 10,
                background: 'var(--color-bg)',
                borderRadius: 8,
                fontSize: 13,
                wordBreak: 'break-all',
              }}
            >
              {referralUrl}
            </code>
            <button onClick={onCopyReferralCode} style={{ padding: '0 16px', whiteSpace: 'nowrap' }}>
              コピー
            </button>
          </div>
          {copyMsg && <p style={{ margin: '8px 0 0', fontSize: 13 }}>{copyMsg}</p>}
        </section>
      )}

      <section
        style={{
          background: '#fff',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 16,
          marginTop: 16,
        }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>あなたのプロフィール</h2>
        <p style={{ margin: '0 0 12px', color: '#6b6358', fontSize: 14 }}>
          AI戦略相談があなたの状況を踏まえて提案できるよう、自由に登録してください（任意）。
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {PROFILE_FIELDS.map((f) => (
            <label key={f.key} style={{ display: 'block', fontSize: 13 }}>
              {f.label}
              {f.type === 'select' ? (
                <select
                  value={userProfile[f.key] ?? ''}
                  onChange={(e) => {
                    setUserProfile((p) => ({ ...p, [f.key]: e.target.value }));
                    setProfileDirty(true);
                  }}
                  style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
                >
                  <option value="">未選択</option>
                  {GENDER_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <AutoResizeTextarea
                  value={userProfile[f.key] ?? ''}
                  onChange={(e) => {
                    setUserProfile((p) => ({ ...p, [f.key]: e.target.value }));
                    setProfileDirty(true);
                  }}
                  rows={2}
                  style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
                />
              ) : (
                <input
                  value={userProfile[f.key] ?? ''}
                  onChange={(e) => {
                    setUserProfile((p) => ({ ...p, [f.key]: e.target.value }));
                    setProfileDirty(true);
                  }}
                  style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
                />
              )}
            </label>
          ))}

          {/* 目標は「目標内容+いつまでに」を複数登録できる(議事録要望) */}
          <div style={{ fontSize: 13 }}>
            目標
            <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
              {goals.map((g, i) => (
                <div key={i} style={{ display: 'grid', gap: 6, background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 8, padding: 8 }}>
                  <input
                    value={g.text}
                    onChange={(e) => {
                      setGoals((gs) => gs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)));
                      setProfileDirty(true);
                    }}
                    placeholder="目標（例: 月間契約10件）"
                    style={{ width: '100%', padding: 8, fontSize: 15 }}
                  />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={g.by}
                      onChange={(e) => {
                        setGoals((gs) => gs.map((x, j) => (j === i ? { ...x, by: e.target.value } : x)));
                        setProfileDirty(true);
                      }}
                      placeholder="いつまでに（例: 2026年内）"
                      style={{ flex: 1, padding: 8, fontSize: 14 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setGoals((gs) => gs.filter((_, j) => j !== i));
                        setProfileDirty(true);
                      }}
                      style={{ padding: '8px 10px', background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b', fontSize: 13 }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setGoals((gs) => [...gs, { text: '', by: '' }]);
                  setProfileDirty(true);
                }}
                style={{ padding: 8, background: '#fff', border: '1px dashed var(--color-border)', color: 'var(--color-primary)', fontSize: 13 }}
              >
                + 目標を追加
              </button>
            </div>
          </div>

          {/* 扱っている商品も目標と同様に複数登録できる(議事録要望)。
              購入条件は廃止し、魅力・概要/ターゲット/届けたい相手を登録できるようにする(議事録要望)。 */}
          <div style={{ fontSize: 13 }}>
            扱っている商品
            <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
              {products.map((prod, i) => (
                <div key={i} style={{ display: 'grid', gap: 6, background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 8, padding: 8 }}>
                  <input
                    value={prod.name}
                    onChange={(e) => {
                      setProducts((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                      setProfileDirty(true);
                    }}
                    placeholder="商品名（例: がん保険）"
                    style={{ width: '100%', padding: 8, fontSize: 15 }}
                  />
                  <input
                    value={prod.price}
                    onChange={(e) => {
                      setProducts((ps) => ps.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)));
                      setProfileDirty(true);
                    }}
                    placeholder="金額（例: 月々3,000円〜）"
                    style={{ width: '100%', padding: 8, fontSize: 14 }}
                  />
                  <AutoResizeTextarea
                    value={prod.appeal}
                    onChange={(e) => {
                      setProducts((ps) => ps.map((x, j) => (j === i ? { ...x, appeal: e.target.value } : x)));
                      setProfileDirty(true);
                    }}
                    placeholder="魅力・概要（例: 保険料そのままで入院給付が手厚い）"
                    rows={2}
                    style={{ width: '100%', padding: 8, fontSize: 14 }}
                  />
                  <input
                    value={prod.target}
                    onChange={(e) => {
                      setProducts((ps) => ps.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)));
                      setProfileDirty(true);
                    }}
                    placeholder="ターゲット（例: 30〜40代の子育て世帯）"
                    style={{ width: '100%', padding: 8, fontSize: 14 }}
                  />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={prod.audience}
                      onChange={(e) => {
                        setProducts((ps) => ps.map((x, j) => (j === i ? { ...x, audience: e.target.value } : x)));
                        setProfileDirty(true);
                      }}
                      placeholder="届けたい相手（例: 保障を見直したいと言っていた人）"
                      style={{ flex: 1, padding: 8, fontSize: 14 }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setProducts((ps) => ps.filter((_, j) => j !== i));
                        setProfileDirty(true);
                      }}
                      style={{ padding: '8px 10px', background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b', fontSize: 13 }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setProducts((ps) => [...ps, { name: '', price: '', appeal: '', target: '', audience: '' }]);
                  setProfileDirty(true);
                }}
                style={{ padding: 8, background: '#fff', border: '1px dashed var(--color-border)', color: 'var(--color-primary)', fontSize: 13 }}
              >
                + 商品を追加
              </button>
            </div>
          </div>
        </div>
        <button
          onClick={onSaveProfile}
          disabled={profileSaving}
          style={{ marginTop: 12, padding: 12, fontSize: 15, width: '100%' }}
        >
          {profileSaving ? '保存中…' : '保存'}
        </button>
        {profileMsg && <p style={{ margin: '8px 0 0', fontSize: 13 }}>{profileMsg}</p>}
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          整頓された項目だけでなく、AIとの対話であなた自身を深掘りすることもできます。
        </p>
        <Link
          to="/self-osarai"
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: 8,
            padding: 12,
            borderRadius: 'var(--btn-radius)',
            background: 'var(--color-primary)',
            color: '#fff',
            textDecoration: 'none',
          }}
        >
          自分をおさらいする
        </Link>
      </section>

      <section
        style={{
          background: '#fff',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 16,
          marginTop: 16,
        }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>通知</h2>
        <p style={{ margin: '0 0 12px', color: '#6b6358', fontSize: 14 }}>
          人と会ったあと「今日会った人、おさらいする？」を通知でお知らせします（習慣化の中核）。
        </p>
        <button onClick={onEnablePush} disabled={busy} style={{ padding: 12, fontSize: 15 }}>
          {busy ? '設定中…' : '通知をオンにする'}
        </button>
        {!isPushSupported() && (
          <p style={{ margin: '8px 0 0', color: '#9a9183', fontSize: 12 }}>
            ※プッシュ通知は実機アプリでのみ有効です。
          </p>
        )}
        {pushMsg && <p style={{ margin: '8px 0 0', fontSize: 13 }}>{pushMsg}</p>}
      </section>

      <button
        onClick={() => supabase.auth.signOut()}
        style={{
          display: 'block',
          margin: '24px auto 0',
          padding: '8px 16px',
          background: 'none',
          border: 'none',
          color: 'var(--color-text-muted)',
          fontSize: 13,
          textDecoration: 'underline',
        }}
      >
        ログアウト
      </button>
    </main>
  );
}
