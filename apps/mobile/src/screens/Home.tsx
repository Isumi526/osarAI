// Home（顧客リスト＋フィルタ＋おさらい導線）。§10。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listCustomers, getMyProfile, type Customer } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { getPersonalStats, type PersonalStats } from '../lib/stats.js';
import { TempIcon } from '../components/TempIcon.js';
import type { Temperature } from '@osarai/shared';

const SELF_INTRO_PROMPTED_KEY = 'osarai_self_intro_prompted';

export function Home() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subActive, setSubActive] = useState(true); // 判定前は制限を出さない
  const [stats, setStats] = useState<PersonalStats | null>(null);

  useEffect(() => {
    getPersonalStats()
      .then(setStats)
      .catch(() => undefined); // 集計失敗はダッシュボード非表示に留め、画面全体は壊さない
  }, []);

  // 初回ログイン(この端末で未案内 かつ プロフィール未登録)ならウェルカム/チュートリアル
  // 画面(/welcome)へ誘導する。いきなり自分をおさらいするに飛ばすと驚くため、まずステップ式の
  // アプリ紹介を挟み、最後に本人が入口を選ぶ(議事録『review』フィードバックでの仕様変更)。
  // localStorageフラグで一度きり。スキップは welcome/self-osarai の導線から可能。
  useEffect(() => {
    if (localStorage.getItem(SELF_INTRO_PROMPTED_KEY)) return;
    getMyProfile()
      .then((p) => {
        const up = (p?.user_profile as Record<string, unknown> | null) ?? {};
        const empty = Object.keys(up).length === 0;
        localStorage.setItem(SELF_INTRO_PROMPTED_KEY, '1');
        if (empty) navigate('/welcome');
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // ステータス(対応中/アーカイブ)概念はユーザーに意識させない。常にactiveのみ表示する
    // (議事録『review』人力回答A・アーカイブ済みは一覧から外れる)。
    // 温度感の絞り込みは削除した(議事録要望)ため全件取得する。
    listCustomers({ status: 'active' })
      .then((rows) => active && setCustomers(rows))
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    getEntitlement()
      .then((e) => setSubActive(e.active))
      .catch(() => setSubActive(true)); // 取得失敗時はブロックしない（APIが最終ゲート）
  }, []);

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 style={{ margin: 0, fontSize: 22 }}>osarAI</h1>
      </header>

      {!subActive && (
        <div
          style={{
            background: '#fff7ed',
            border: '1px solid #f0d9b5',
            borderRadius: 10,
            padding: 12,
            margin: '12px 0',
            fontSize: 13,
            color: '#8a6d3b',
          }}
        >
          ご利用にはお申し込みが必要です。登録・プラン変更はWebから行えます（14日無料トライアル）。
        </div>
      )}

      {stats && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
            margin: '12px 0',
          }}
        >
          {[
            { label: '今後の予定', value: stats.upcomingSchedules },
            { label: '今月のアポ', value: stats.monthAppointments },
            { label: '今月のおさらい', value: stats.monthOsarai },
            { label: '累計アポ', value: stats.totalAppointments },
            { label: '累計おさらい', value: stats.totalOsarai },
            { label: '今月の新規つながり', value: stats.monthNewCustomers },
            { label: '累計つながり', value: stats.totalCustomers },
            { label: '今月の会議', value: stats.monthMeetings },
            { label: '今後の会議', value: stats.upcomingMeetings },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: '#fff',
                border: '1px solid var(--color-border)',
                borderRadius: 10,
                padding: 10,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-primary)' }}>{s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* 新規ユーザー向けのアクション誘導(議事録要望)。今後の予定が無ければ予定登録を、
          いつでも「つながりAI登録」を勧める。予定登録の誘導があるので、ここでは
          「おさらいする」ボタンは主要導線から外し、下のAI相談と横並びにする。 */}
      {stats && stats.upcomingSchedules === 0 && (
        <button
          onClick={() => navigate('/schedule')}
          style={{
            width: '100%',
            margin: '16px 0 8px',
            padding: 14,
            fontSize: 15,
            textAlign: 'left',
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary-border)',
            color: 'var(--color-text)',
          }}
        >
          📅 まずは人と会う予定をカレンダーに登録しましょう
        </button>
      )}
      <button
        onClick={() => navigate('/customers/new')}
        disabled={!subActive}
        style={{
          width: '100%',
          marginBottom: 8,
          padding: 14,
          fontSize: 15,
          textAlign: 'left',
          background: '#fff',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text)',
        }}
      >
        🤝 あの人について、AIとおさらいしてみる（つながりAI登録）
      </button>

      <div style={{ display: 'flex', gap: 8, margin: '8px 0 16px' }}>
        <button
          onClick={() => navigate('/osarai')}
          disabled={!subActive}
          style={{ flex: 1, padding: 12, fontSize: 15 }}
        >
          ＋ おさらいする
        </button>
        <button
          onClick={() => navigate('/chat')}
          disabled={!subActive}
          style={{ flex: 1, padding: 12, fontSize: 15 }}
        >
          AIに相談
        </button>
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {loading ? (
        <p>読み込み中…</p>
      ) : customers.length === 0 ? (
        <p style={{ color: '#6b6358' }}>
          まだつながりがいません。「＋つながり」または「おさらいする」から追加できます。
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {customers.map((c) => (
            <li key={c.id}>
              <Link
                to={`/customers/${c.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  background: '#fff',
                  border: '1px solid var(--color-border)',
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span>
                  {c.temperature ? <TempIcon value={c.temperature as Temperature} /> : null} {c.name}
                </span>
                {c.needs && (
                  <span style={{ color: '#9a9183', fontSize: 13, maxWidth: '50%' }}>{c.needs}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* +つながりを右下固定のFABに(タップしやすさ・議事録要望)。下部ナビの上に配置。 */}
      <button
        onClick={() => navigate('/customers/new')}
        disabled={!subActive}
        aria-label="つながりを追加"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 'calc(56px + env(safe-area-inset-bottom) + 16px)',
          width: 56,
          height: 56,
          borderRadius: '50%',
          fontSize: 28,
          lineHeight: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          zIndex: 90,
        }}
      >
        ＋
      </button>
    </main>
  );
}
