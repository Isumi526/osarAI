// Home（顧客リスト＋フィルタ＋おさらい導線）。§10。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getMyProfile } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { getPersonalStats, type PersonalStats } from '../lib/stats.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { ChatBubbleIcon } from '../components/NavIcons.js';
import { AddToHomeScreenBanner } from '../components/AddToHomeScreenBanner.js';

const SELF_INTRO_PROMPTED_KEY = 'osarai_self_intro_prompted';

export function Home() {
  const navigate = useNavigate();
  const [subActive, setSubActive] = useState(true); // 判定前は制限を出さない
  const [stats, setStats] = useState<PersonalStats | null>(null);

  useEffect(() => {
    getPersonalStats()
      .then(setStats)
      .catch(() => undefined); // 集計失敗はダッシュボード非表示に留め、画面全体は壊さない
  }, []);

  // 初回ログイン(このアカウントで未案内 かつ プロフィール未登録)ならウェルカム/チュートリアル
  // 画面(/welcome)へ誘導する。いきなり自分をおさらいするに飛ばすと驚くため、まずステップ式の
  // アプリ紹介を挟み、最後に本人が入口を選ぶ(議事録『review』フィードバックでの仕様変更)。
  // localStorageフラグで一度きり。スキップは welcome/self-osarai の導線から可能。
  // 【重要】フラグはユーザーID単位でキー化する。端末単位(共通キー)だと、同じ端末で
  // 別アカウントが先にHomeを開いただけで以降誰もウェルカムに案内されなくなる
  // (本番で確認された不具合: 既存アカウントで一度Homeを開いた端末では、後から
  // サインアップした新規アカウントがウェルカムに一切案内されなかった)。
  useEffect(() => {
    getMyProfile()
      .then((p) => {
        if (!p) return;
        const key = `${SELF_INTRO_PROMPTED_KEY}:${p.id}`;
        if (localStorage.getItem(key)) return;
        const up = (p.user_profile as Record<string, unknown> | null) ?? {};
        const empty = Object.keys(up).length === 0;
        localStorage.setItem(key, '1');
        if (empty) navigate('/welcome');
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getEntitlement()
      .then((e) => setSubActive(e.active))
      .catch(() => setSubActive(true)); // 取得失敗時はブロックしない（APIが最終ゲート）
  }, []);

  return (
    <main className="screen">
      <ScreenHeader>
        <h1 style={{ margin: 0, fontSize: 22 }}>osarAI</h1>
        {/* 使い方はいつでも見返せるよう右上に常設する（ITに不慣れなユーザー向け） */}
        <Link to="/tutorial" style={{ fontSize: 13, color: 'var(--color-primary)', textDecoration: 'none' }}>
          使い方
        </Link>
      </ScreenHeader>

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

      {/* ホーム画面への追加(PWA)案内。ブラウザ利用者向け。ネイティブ/追加済み/
          「今後表示しない」を押した場合は何も描画しない(空の余白も出ない)。 */}
      <AddToHomeScreenBanner style={{ margin: '12px 0' }} />

      {/* 集計ブロックは読み込み前から表示しておき、読み込み中は数値を「-」にする
          (議事録要望: 非表示→いきなり表示だと鬱陶しいため)。 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          margin: '12px 0',
        }}
      >
        {[
          { label: '今月のアポ', value: stats?.monthAppointments },
          { label: '今月のおさらい', value: stats?.monthOsarai },
          { label: '累計アポ', value: stats?.totalAppointments },
          { label: '累計おさらい', value: stats?.totalOsarai },
          { label: '今月の新規つながり', value: stats?.monthNewCustomers },
          { label: '累計つながり', value: stats?.totalCustomers },
          { label: '今月の会議', value: stats?.monthMeetings },
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
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-primary)' }}>{s.value ?? '-'}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* 入口はAIチャット1つに統一する（2026-08-06 UI/UX刷新）。
          旧: おさらいする/AIに相談の2ボタン・つながりAI登録ボタン・予定登録バナー・
          右下の＋FAB・つながり一覧 をホームから撤去し、情報過多を解消した。
          つながり一覧はマイページ配下(/customers)へ、おさらい/相談はこのAIボタンへ集約。 */}
      <button
        onClick={() => navigate('/chat')}
        disabled={!subActive}
        aria-label="AIと話す"
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 'calc(56px + env(safe-area-inset-bottom) + 20px)',
          width: 'min(320px, calc(100% - 32px))',
          padding: '16px 20px',
          fontSize: 16,
          fontWeight: 700,
          borderRadius: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          zIndex: 90,
        }}
      >
        <ChatBubbleIcon size={22} color="#fff" />
        AIと話す
      </button>
    </main>
  );
}
