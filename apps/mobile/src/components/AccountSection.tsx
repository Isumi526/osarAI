// マイページの「ご契約」と「退会」（2026-09-28・人判断）。
// - ご契約: 今のプランと状態、Web の契約管理（プランの確認・変更・解約）への導線。
//   ストア版アプリ（Capacitor）では出さない（アプリ内に課金への導線を置かない＝App Store の審査対策・CLAUDE.md §11）。
// - 退会: アプリ内で完結させる（窓口への連絡は手間）。目立たせすぎないが、隠しもしない。
//   ストアのガイドラインでもアプリ内でのアカウント削除が求められるので、ネイティブでも出す。
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { getEntitlement, type Entitlement } from '../lib/subscription.js';
import { deleteMyAccount } from '../lib/account.js';
import { supabase } from '../lib/supabase.js';

const STATUS_JA: Record<string, string> = {
  trialing: '無料期間中',
  active: 'ご契約中',
  past_due: 'お支払いの確認が必要です',
  unpaid: 'お支払いの確認が必要です',
  canceled: '解約済み',
  incomplete: 'お手続き中',
};

export function ContractSection({ webOrigin }: { webOrigin: string }) {
  const [ent, setEnt] = useState<Entitlement | null>(null);
  useEffect(() => {
    getEntitlement()
      .then(setEnt)
      .catch(() => undefined);
  }, []);
  if (Capacitor.isNativePlatform()) return null;
  const planName = ent?.def?.name ?? (ent?.plan ? ent.plan : 'ー');
  const status = ent?.status ? (STATUS_JA[ent.status] ?? ent.status) : '未契約';
  return (
    <section style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, padding: 16, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>ご契約</h2>
      <p style={{ margin: '0 0 12px', fontSize: 14 }}>
        プラン: <b>{planName}</b>（{status}）
      </p>
      <a
        href={`${webOrigin}/billing`}
        target="_blank"
        rel="noopener"
        style={{
          display: 'block',
          textAlign: 'center',
          padding: '12px 16px',
          borderRadius: 24,
          border: '1px solid var(--color-border)',
          color: 'var(--color-text)',
          textDecoration: 'none',
          fontSize: 14,
        }}
      >
        プランの確認・変更・解約
      </a>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>
        Web のお支払い管理が開きます（ログインを求められた場合は、同じメールアドレスでログインしてください）。
      </p>
    </section>
  );
}

export function DeleteAccountSection() {
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <section style={{ marginTop: 24, padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, textAlign: 'center' }}>
        <p style={{ margin: '0 0 12px' }}>退会が完了しました。これまでご利用いただき、ありがとうございました。</p>
        <button type="button" onClick={() => void supabase.auth.signOut()} style={{ padding: '0 20px' }}>
          閉じる
        </button>
      </section>
    );
  }

  return (
    <div style={{ marginTop: 8, textAlign: 'center' }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 13, textDecoration: 'underline', padding: '8px 16px' }}
        >
          退会する
        </button>
      ) : (
        <section style={{ textAlign: 'left', marginTop: 8, padding: 16, background: '#fff', border: '1px solid var(--color-danger)', borderRadius: 12, display: 'grid', gap: 10 }}>
          <strong>退会する</strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
            <li>録音した音声、議事録、予定、TODO、つながりの情報など、<b>すべてのデータが削除され、元に戻せません</b>。</li>
            <li>ご契約は<b>すぐに解約</b>されます。お支払い済みの期間の返金はありません。</li>
            <li>同じメールアドレスで、あとから新しく登録し直すことはできます。</li>
          </ul>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ width: 18, height: 18 }} />
            上記を理解したうえで退会します
          </label>
          {error && <p style={{ margin: 0, fontSize: 13, color: 'var(--color-danger)' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setUnderstood(false);
                setError(null);
              }}
              style={{ flex: 1, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              やめる
            </button>
            <button
              type="button"
              disabled={!understood || busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await deleteMyAccount();
                  setDone(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
              style={{ flex: 1, background: 'var(--color-danger)', opacity: understood ? 1 : 0.5 }}
            >
              {busy ? '退会しています…' : '退会する'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
