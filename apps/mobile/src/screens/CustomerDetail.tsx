// CustomerDetail（カード＋タイムライン＝interactions時系列）。§9 F-01 + F-03(録音取り込み)。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  getCustomer,
  listInteractions,
  archiveCustomer,
  type Customer,
  type Interaction,
} from '../lib/db.js';
import { importRecording } from '../lib/recordings.js';
import { TempIcon, TEMP_JA } from '../components/TempIcon.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import type { AiSummary, InteractionSource, Temperature } from '@osarai/shared';

// 録音取り込み機能はphase2に見送り（議事録『review』・回答A）。UIを非表示にする。
// 実装本体(importRecording/onPickRecording)は残し、フラグ切替でphase2に復帰できるようにする。
const SHOW_RECORDING_IMPORT = false;

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
  const [recSource, setRecSource] = useState<InteractionSource>('in_person_rec');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  function reload() {
    if (!id) return;
    setLoading(true);
    Promise.all([getCustomer(id), listInteractions(id)])
      .then(([c, ix]) => {
        setCustomer(c);
        setInteractions(ix);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onRequestPickRecording() {
    // 録音同意の注意喚起（要件定義書§6/§10）。商談録音は相手の会話を含むため、
    // アップロード前に必ず確認を挟む（フォーム化はしない＝1タップの確認のみ）。
    const ok = await confirm(
      'この録音には相手（お客様）の会話が含まれます。\n事前に録音の同意を得ていることを確認してください。\n\nよろしければ「OK」でファイルを選択します。',
    );
    if (!ok) return;
    fileRef.current?.click();
  }

  async function onPickRecording(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = ''; // 同じファイルを再選択できるように
    if (!file || !id) return;
    setError(null);
    setImporting(true);
    try {
      await importRecording({ customerId: id, file, source: recSource });
      reload();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setImporting(false);
    }
  }

  // 「削除」は論理削除(アーカイブ)。一覧に表示されなくなるが、履歴を含むデータは保持される
  // (ステータス概念自体はユーザーに意識させない・議事録『review』人力回答A)。
  async function onDelete() {
    if (!id || !(await confirm('このつながりをアーカイブしますか？（一覧に表示されなくなります。データは保持されます）'))) return;
    try {
      await archiveCustomer(id);
      navigate('/');
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) return <main className="screen">読み込み中…</main>;
  if (!customer) return <main className="screen">つながりが見つかりません。<Link to="/">戻る</Link></main>;

  return (
    <main className="screen">
      <Link to="/">← 一覧</Link>

      {/* 顧客カード */}
      <section
        style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, padding: 16, marginTop: 12 }}
      >
        <h1 style={{ margin: '0 0 8px' }}>{customer.name}</h1>
        <p style={{ margin: '4px 0' }}>
          温度感: {customer.temperature ? (
            <>
              <TempIcon value={customer.temperature as Temperature} /> {TEMP_JA[customer.temperature as Temperature]}
            </>
          ) : '—'}
        </p>
        {customer.needs && <p style={{ margin: '4px 0' }}>ニーズ: {customer.needs}</p>}
        {(() => {
          // おさらい対話のAI抽出で custom_fields に入る想定の商品/年齢/性別（0007の
          // userProfile.products/age/genderと同じパターン）。値があるものだけ表示。
          const cf = (customer.custom_fields ?? {}) as Record<string, unknown>;
          const age = typeof cf.age === 'string' ? cf.age : undefined;
          const gender = typeof cf.gender === 'string' ? cf.gender : undefined;
          const products = Array.isArray(cf.products)
            ? cf.products.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : typeof cf.products === 'string' && cf.products.trim()
              ? [cf.products]
              : [];
          if (!age && !gender && products.length === 0) return null;
          return (
            <p style={{ margin: '4px 0' }}>
              {age && <>年齢: {age}　</>}
              {gender && <>性別: {gender}　</>}
              {products.length > 0 && <>扱っている商品: {products.join('、')}</>}
            </p>
          );
        })()}
        {customer.last_met_at && (
          <p style={{ margin: '4px 0', color: '#9a9183', fontSize: 13 }}>
            最終接触: {new Date(customer.last_met_at).toLocaleDateString('ja-JP')}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => navigate(`/customers/${customer.id}/edit`)} style={{ flex: 1, padding: 10 }}>
            編集
          </button>
          <button
            onClick={onDelete}
            style={{ padding: 10, background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}
          >
            アーカイブ
          </button>
        </div>
      </section>

      {/* 導線: おさらい / 録音取り込み（F-03サブ経路） */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => navigate(`/osarai?customerId=${customer.id}`)}
          style={{ flex: 1, padding: 10 }}
        >
          ＋ この人をおさらい
        </button>
        <button
          onClick={() => navigate(`/chat?customerId=${customer.id}`)}
          style={{ padding: 10 }}
        >
          相談
        </button>
      </div>
      {SHOW_RECORDING_IMPORT && (
        <section
          style={{
            background: '#fff',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: 12,
            marginTop: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              value={recSource}
              onChange={(e) => setRecSource(e.target.value as InteractionSource)}
              disabled={importing}
            >
              <option value="in_person_rec">対面録音</option>
              <option value="zoom_rec">Zoom録画</option>
            </select>
            <button onClick={onRequestPickRecording} disabled={importing} style={{ flex: 1, padding: 10 }}>
              {importing ? '取り込み中…（文字起こし）' : '録音を取り込む'}
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            onChange={onPickRecording}
            style={{ display: 'none' }}
          />
          <p style={{ margin: '8px 0 0', color: '#9a9183', fontSize: 12 }}>
            録れた時だけの任意導線。音声から自動で要約・タイムライン化します。
          </p>
          <p style={{ margin: '4px 0 0', color: '#9a9183', fontSize: 12 }}>
            ※相手の会話が含まれる録音です。事前に同意を得た上でご利用ください。
          </p>
        </section>
      )}

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
                style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 10, padding: 12 }}
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
                  <p style={{ margin: '6px 0 0', color: 'var(--color-primary)', fontSize: 13 }}>
                    次アクション: {summary.next_actions.join(' / ')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {confirmDialog}
    </main>
  );
}
