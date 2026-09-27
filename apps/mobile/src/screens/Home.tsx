// Home。§10。2026-09-27 に「次の行動」中心へ作り替え（次に会う人・TODO・最近の会議）。
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getMyProfile } from '../lib/db.js';
import { getEntitlement } from '../lib/subscription.js';
import { listSchedules, type Schedule } from '../lib/schedules.js';
import { listTasks, type Task } from '../lib/tasks.js';
import { listSavedMeetings, type SavedMeeting } from '../lib/meeting.js';
import { listCustomers, type Customer } from '../lib/db.js';
import { supabase } from '../lib/supabase.js';
import { meetingRecapLine as recapLine } from '@osarai/shared';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { ChatBubbleIcon } from '../components/NavIcons.js';
import { BellIcon } from '../components/BellIcon.js';
import { countUnread } from '../lib/notifications.js';
import { AddToHomeScreenBanner } from '../components/AddToHomeScreenBanner.js';
import { PendingRecordingsBanner } from '../components/PendingRecordingsBanner.js';

const SELF_INTRO_PROMPTED_KEY = 'osarai_self_intro_prompted';

export function Home() {
  const navigate = useNavigate();
  const [subActive, setSubActive] = useState(true); // 判定前は制限を出さない
  const [upcoming, setUpcoming] = useState<{ schedule: Schedule; name: string | null; recap: string | null }[]>([]);
  const [todos, setTodos] = useState<Task[]>([]);
  const [meetings, setMeetings] = useState<SavedMeeting[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    // 未読が取れなくてもホームは出す（バッジが出ないだけ）
    countUnread()
      .then(setUnreadCount)
      .catch(() => undefined);
  }, []);

  // ホームの3ブロック。どれかが取れなくても他は出す（空表示に留める）。
  useEffect(() => {
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 86400_000);
    void Promise.all([
      listCustomers({ status: 'active' }).catch(() => [] as Customer[]),
      listSchedules({ from: now.toISOString(), to: weekLater.toISOString() }).catch(() => [] as Schedule[]),
      listTasks({ status: 'open' }).catch(() => [] as Task[]),
      listSavedMeetings(3).catch(() => [] as SavedMeeting[]),
    ]).then(async ([cs, schedules, tasks, ms]) => {
      setCustomers(cs);
      setTodos(tasks);
      setMeetings(ms);
      const next = schedules.filter((x) => new Date(x.start_at) >= now).slice(0, 3);
      // 相手ごとに直近の議事録（無ければ要点）から1行を作り、「前回の話」として添える
      const ids = [...new Set(next.map((x) => x.customer_id).filter((x): x is string => !!x))];
      const recaps = new Map<string, string>();
      if (ids.length) {
        const { data } = await supabase
          .from('interactions')
          .select('customer_id, ai_summary, met_at')
          .in('customer_id', ids)
          .order('met_at', { ascending: false, nullsFirst: false })
          .limit(30);
        for (const r of data ?? []) {
          if (recaps.has(r.customer_id)) continue;
          const sum = (r.ai_summary ?? {}) as { minutes?: string; points?: string[] };
          const line = recapLine(sum.minutes ?? null) ?? sum.points?.[0] ?? null;
          if (line) recaps.set(r.customer_id, line);
        }
      }
      setUpcoming(
        next.map((x) => ({
          schedule: x,
          name: x.customer_id ? (cs.find((c) => c.id === x.customer_id)?.name ?? null) : null,
          recap: x.customer_id ? (recaps.get(x.customer_id) ?? null) : null,
        })),
      );
      setLoaded(true);
    });
  }, []);

  const nameOf = (id: string | null) => (id ? (customers.find((c) => c.id === id)?.name ?? null) : null);
  const myTodos = todos.filter((t) => t.assignee !== 'other').slice(0, 3);
  const waitingTodos = todos.filter((t) => t.assignee === 'other').slice(0, 2);
  const isEmpty = upcoming.length === 0 && todos.length === 0 && meetings.length === 0;

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
    <main className="screen screen--wide" style={{ paddingBottom: 'calc(56px + env(safe-area-inset-bottom) + 40px)' }}>
      <ScreenHeader
        // スマホはブランド名、PC はサイドバーにロゴがあるので画面名（2026-09-27）
        title={
          <>
            <span className="hide-on-desktop">osarAI</span>
            <span className="show-on-desktop">ホーム</span>
          </>
        }
        actions={
          // 通知ベル（未読は赤いバッジ）。PC ではサイドバーの「通知」に未読数を出すので隠す
          <Link to="/notifications" aria-label="通知" className="hide-on-desktop" style={{ color: 'var(--color-text)', display: 'inline-flex' }}>
            <BellIcon unread={unreadCount} />
          </Link>
        }
      />

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
      {/* 保存されていない録音（途中で止まった等）。ある時だけ一番上に出す */}
      <PendingRecordingsBanner />
      <AddToHomeScreenBanner style={{ margin: '12px 0' }} />

      {/* 2026-09-27 ホームを「次の行動」中心に作り替え（人判断）。会議録音が主導線になり、
          目的が「会う前に思い出す」「約束を忘れない」になったため、数字のダッシュボード
          （マイページへ移設）ではなく、次に会う人・TODO・最近の会議を並べる。
          会議を録音する入口は下部ナビ中央の大きなボタン、AIと話すは下の控えめな1行に。 */}
      {loaded && isEmpty ? (
        <section style={cardStyle}>
          <strong style={{ fontSize: 16 }}>まずは会議を録音してみましょう</strong>
          <p style={{ margin: '8px 0 12px', fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
            下の真ん中のボタンから始められます。終わると議事録・予定・TODOが自動で保存され、ここに次の行動が並びます。
          </p>
          <button type="button" onClick={() => navigate('/meeting')} disabled={!subActive} style={{ width: '100%', minHeight: 48 }}>
            会議を録音する
          </button>
        </section>
      ) : (
        <div className="home-grid">
          <HomeSection className="ga-up" title="次に会う人" moreTo="/schedule" moreLabel="予定を見る">
            {upcoming.length === 0 ? (
              <Empty>1週間以内の予定はありません</Empty>
            ) : (
              upcoming.map((u) => (
                <li key={u.schedule.id} style={rowStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700 }}>
                      {fmtWhen(u.schedule.start_at)} {u.name ? `${u.name}さん` : u.schedule.title}
                    </span>
                    {u.schedule.customer_id && (
                      <Link to={`/customers/${u.schedule.customer_id}`} style={{ fontSize: 13, whiteSpace: 'nowrap', color: 'var(--color-primary)' }}>
                        前回の話 ›
                      </Link>
                    )}
                  </div>
                  {/* 相手が決まっている予定だけ「前回の話」を添える（相手なしの予定に出すと誤解を招く） */}
                  {u.schedule.customer_id && (
                    <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
                      {u.recap ?? '前回の記録はまだありません'}
                    </div>
                  )}
                </li>
              ))
            )}
          </HomeSection>

          <HomeSection className="ga-todo" title="TODO" moreTo="/tasks" moreLabel="すべて見る">
            {myTodos.length === 0 && waitingTodos.length === 0 ? (
              <Empty>未完了のTODOはありません</Empty>
            ) : (
              <>
                {myTodos.map((t) => (
                  <li key={t.id} style={rowStyle}>
                    <span>{t.title}</span>
                    <span style={{ fontSize: 12, color: isOverdue(t.due_at) ? 'var(--color-danger)' : 'var(--color-text-muted)', marginLeft: 8 }}>
                      {t.due_at ? fmtDue(t.due_at) : ''}
                    </span>
                  </li>
                ))}
                {waitingTodos.map((t) => (
                  <li key={t.id} style={{ ...rowStyle, color: 'var(--color-text-muted)' }}>
                    <span style={{ fontSize: 12, marginRight: 6 }}>相手待ち</span>
                    {t.title}
                    {nameOf(t.customer_id) && <span style={{ fontSize: 12 }}>（{nameOf(t.customer_id)}さん）</span>}
                  </li>
                ))}
              </>
            )}
          </HomeSection>

          <HomeSection className="ga-mt" title="最近の会議" moreTo="/meetings" moreLabel="会議の記録">
            {meetings.length === 0 ? (
              <Empty>まだ会議の記録はありません</Empty>
            ) : (
              meetings.map((m) => (
                <li key={m.id} style={rowStyle}>
                  <Link to={`/meetings/${m.id}`} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginRight: 8 }}>
                      {new Date(m.created_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
                    </span>
                    <span style={{ fontWeight: 700 }}>{nameOf(m.customer_id) ? `${nameOf(m.customer_id)}さん` : '相手未特定'}</span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}> — {recapLine(m.minutes) ?? '議事録なし'}</span>
                  </Link>
                </li>
              ))
            )}
          </HomeSection>
          <AiEntry className="ga-ai" onClick={() => navigate('/chat')} disabled={!subActive} />
        </div>
      )}

      {/* 空の時も AI への入口は出す（PC の2列はデータがある時だけ） */}
      {loaded && isEmpty && <AiEntry onClick={() => navigate('/chat')} disabled={!subActive} />}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
  padding: 16,
  marginTop: 12,
};
const rowStyle: React.CSSProperties = { padding: '10px 0', borderTop: '1px solid var(--color-border)', fontSize: 14 };

function HomeSection({
  title,
  moreTo,
  moreLabel,
  children,
  className,
}: {
  title: string;
  moreTo: string;
  moreLabel: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className} style={{ ...cardStyle, paddingBottom: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
        <Link to={moreTo} style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          {moreLabel} ›
        </Link>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{children}</ul>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <li style={{ ...rowStyle, color: 'var(--color-text-muted)', fontSize: 13 }}>{children}</li>;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400_000);
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `今日 ${hm}`;
  if (diff === 1) return `明日 ${hm}`;
  return `${d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })} ${hm}`;
}

function fmtDue(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })}まで`;
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(iso) < today;
}

/** AIへの相談・メモの入口（控えめな1行）。PC では2列の右下に入る */
function AiEntry({ onClick, disabled, className }: { onClick: () => void; disabled: boolean; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        marginTop: 12,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#fff',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text)',
        borderRadius: 12,
        fontSize: 15,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ChatBubbleIcon size={20} color="var(--color-primary)" />
        AIに相談する・メモを話す
      </span>
      <span style={{ color: 'var(--color-text-muted)' }}>›</span>
    </button>
  );
}
