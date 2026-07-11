// Settings（プロフィール／通知許可）。※課金導線は置かない（§11 IAP回避）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { enablePush, isPushSupported } from '../lib/push.js';
import { getMyProfile, updateMyUserProfile } from '../lib/db.js';

const PROFILE_FIELDS: { key: string; label: string }[] = [
  { key: 'age', label: '年齢' },
  { key: 'gender', label: '性別' },
  { key: 'background', label: '経歴' },
  { key: 'job', label: '仕事' },
  { key: 'products', label: '扱っている商品' },
  { key: 'goal', label: '目標' },
];

export function Settings() {
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // AI戦略相談のコンテキストに使う自分のプロフィール
  const [userProfile, setUserProfile] = useState<Record<string, string>>({});
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  // 紹介コード（自分のprofiles.idから決定的に導出。別テーブル管理なし）
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        const up = (p?.user_profile as Record<string, string> | null) ?? {};
        setUserProfile(up);
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
      await updateMyUserProfile(userProfile);
      setProfileMsg('保存しました。');
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
        <strong>設定</strong>
        <span style={{ width: 48 }} />
      </header>

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
              <input
                value={userProfile[f.key] ?? ''}
                onChange={(e) => setUserProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                style={{ width: '100%', padding: 10, fontSize: 15, marginTop: 4 }}
              />
            </label>
          ))}
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
