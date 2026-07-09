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

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        const up = (p?.user_profile as Record<string, string> | null) ?? {};
        setUserProfile(up);
      })
      .catch(() => {});
  }, []);

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
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
      </section>

      <p style={{ marginTop: 16, color: '#9a9183', fontSize: 13 }}>
        課金・プランの管理はWebから行います（アプリ内に決済導線はありません）。
      </p>

      <button
        onClick={() => supabase.auth.signOut()}
        style={{ marginTop: 16, padding: 12, fontSize: 16 }}
      >
        ログアウト
      </button>
    </main>
  );
}
