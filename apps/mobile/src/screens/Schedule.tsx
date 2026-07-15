// スケジュール管理（月/週/日 グリッドカレンダー・顧客紐付け任意）。§14フェーズ後追加。
// Google/Appleカレンダー品質のグリッドUIに刷新（旧: アジェンダ形式のリスト表示）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listCustomers, getMyProfile, createCustomer, type Customer, type Profile } from '../lib/db.js';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  findFreeSlots,
  formatScheduleProposalText,
  listLocationHistory,
  SCHEDULE_CATEGORIES,
  SCHEDULE_MODES,
  type Schedule,
  type ScheduleInput,
} from '../lib/schedules.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useEscapeKey } from '../components/useEscapeKey.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { RequiredMark } from '../components/RequiredMark.js';
import { analyzeCustomerText, analyzeCustomerImage } from '../lib/customerAnalyze.js';
import { useNavigate } from 'react-router-dom';

type ViewMode = 'month' | 'week' | 'day';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_HEIGHT = 56; // 1時間あたりの高さ(px)。0-24時の全日をスクロール表示(Google/Appleカレンダー同様)。
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// カテゴリ別の予定ブロック色(議事録要望)。未設定/未知のカテゴリは既定色。
const CATEGORY_COLORS: Record<string, string> = {
  アポ: '#fd780f', // 既定のオレンジ
  商談: '#0f9d8f', // 青緑
  会議: '#3b82f6', // 青
  私用: '#8b5cf6', // 紫
  その他: '#6b7280', // グレー
};
function categoryColor(category: string | null): string {
  return (category && CATEGORY_COLORS[category]) || 'var(--color-primary)';
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  r.setDate(r.getDate() - r.getDay()); // 日曜始まり
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`;
}
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
// 「週」タブは横幅が足りないモバイル画面向けに3日表示にする(議事録『review(2回目)』要望)。
const MULTI_DAY_COUNT = 3;

function rangeFor(view: ViewMode, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === 'week') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), MULTI_DAY_COUNT) };
  // 月ビューは表示するグリッド(前後月の余白週含む)を丸ごと取得する
  const gridStart = startOfWeek(startOfMonth(anchor));
  return { from: gridStart, to: addDays(gridStart, 42) };
}
function fmtRangeLabel(view: ViewMode, anchor: Date): string {
  if (view === 'day') return anchor.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  if (view === 'week') {
    const s = startOfDay(anchor);
    const e = addDays(s, MULTI_DAY_COUNT - 1);
    return `${s.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })} 〜 ${e.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })}`;
  }
  return anchor.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
}
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 同じ日の予定同士が重なっている場合、横並びの列に振り分ける(AC④: 重なりの可視化)。
// 貪欲法: 開始時刻順に、空いている最初の列に入れる。使った列数が最大同時重複数になる。
function layoutOverlaps(items: Schedule[]): { schedule: Schedule; col: number; cols: number }[] {
  const sorted = [...items].sort((a, b) => +new Date(a.start_at) - +new Date(b.start_at));
  const colEnds: number[] = []; // 各列の現在の終了時刻(ms)
  const placed: { schedule: Schedule; col: number }[] = [];
  for (const s of sorted) {
    const start = +new Date(s.start_at);
    const end = +new Date(s.end_at);
    let col = colEnds.findIndex((endMs) => endMs <= start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(end);
    } else {
      colEnds[col] = end;
    }
    placed.push({ schedule: s, col });
  }
  const cols = Math.max(1, colEnds.length);
  return placed.map((p) => ({ ...p, cols }));
}

// 最後に選んだ表示区分(月/週/日)を記憶し、再訪・再起動後も同じ区分で開く(議事録要望)。
const VIEW_STORAGE_KEY = 'osarai_schedule_view';
function loadInitialView(): ViewMode {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_STORAGE_KEY) : null;
  return v === 'month' || v === 'week' || v === 'day' ? v : 'week';
}

export function SchedulePage() {
  const [view, setViewRaw] = useState<ViewMode>(loadInitialView);
  const setView = (v: ViewMode) => {
    setViewRaw(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* localStorage不可の環境では記憶を諦める(表示自体は動く) */
    }
  };
  const [anchor, setAnchor] = useState(() => new Date());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locationHistory, setLocationHistory] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [presetSlot, setPresetSlot] = useState<Date | null>(null);
  // 予定作成中にその場で登録した新規つながりに対し、詳しい登録を提案するモーダル。
  const [proposeCustomer, setProposeCustomer] = useState<Customer | null>(null);
  const navigate = useNavigate();
  const [proposal, setProposal] = useState<{ text: string; copyMsg: string | null } | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  useEscapeKey(() => setProposeCustomer(null), !!proposeCustomer);
  useEscapeKey(() => setProposal(null), !!proposal);
  // 月表示の無限スクロール(回答A): 縦に連続表示する月のリスト。上下端で前後の月を継ぎ足す。
  const [monthList, setMonthList] = useState<Date[]>([]);
  const monthScrollRef = useRef<HTMLDivElement>(null);
  const prependAdjustRef = useRef<number | null>(null);
  // 前後移動(</>)のたびに一覧を丸ごとブランクにすると体感の遅延・ちらつきが大きいため、
  // 初回読み込みの時だけ「読み込み中…」を出し、以降の再取得は前の表示を残したまま裏で
  // 差し替える(議事録要望: 前後移動時のもたつき軽減)。
  const loadedOnceRef = useRef(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  // 月表示に入る/基準日(今日ボタン等)が変わったら、その月を中心に前後1ヶ月で初期化。
  useEffect(() => {
    if (view !== 'month') return;
    const base = startOfMonth(anchor);
    setMonthList([addMonths(base, -1), base, addMonths(base, 1)]);
  }, [view, anchor]);

  // prepend(上方向の月追加)後にスクロール位置を補正し、表示のジャンプを防ぐ。
  useLayoutEffect(() => {
    if (prependAdjustRef.current == null || !monthScrollRef.current) return;
    const el = monthScrollRef.current;
    el.scrollTop += el.scrollHeight - prependAdjustRef.current;
    prependAdjustRef.current = null;
  }, [monthList]);

  function onMonthScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop < 150 && prependAdjustRef.current == null) {
      prependAdjustRef.current = el.scrollHeight;
      setMonthList((list) => (list.length ? [addMonths(list[0]!, -1), ...list] : list));
    } else if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      setMonthList((list) => (list.length ? [...list, addMonths(list[list.length - 1]!, 1)] : list));
    }
  }

  useEffect(() => {
    getMyProfile().then(setProfile);
    listCustomers({ status: 'active' }).then(setCustomers).catch(() => undefined);
    listLocationHistory().then(setLocationHistory).catch(() => undefined);
  }, []);

  // 日程調整の文章生成(議事録『review』人力回答A寄り): 表示中のビューに関わらず、
  // 「今」から直近7日間の予定を取得して空き時間を探す(AIは使わず既存データからの計算)。
  async function openProposal() {
    setProposalLoading(true);
    setError(null);
    try {
      const now = new Date();
      const to = addDays(now, 7);
      const upcoming = await listSchedules({ from: now.toISOString(), to: to.toISOString() });
      const slots = findFreeSlots(upcoming, now);
      setProposal({ text: formatScheduleProposalText(slots), copyMsg: null });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setProposalLoading(false);
    }
  }

  async function onCopyProposal() {
    if (!proposal) return;
    try {
      await navigator.clipboard.writeText(proposal.text);
      setProposal({ ...proposal, copyMsg: 'コピーしました。' });
    } catch {
      setProposal({ ...proposal, copyMsg: null });
    }
  }

  function reload() {
    // 月表示の無限スクロール時は、表示中の全月のグリッド範囲をまとめて取得する。
    let from: Date;
    let to: Date;
    if (view === 'month' && monthList.length) {
      from = startOfWeek(startOfMonth(monthList[0]!));
      to = addDays(startOfWeek(startOfMonth(monthList[monthList.length - 1]!)), 42);
    } else {
      ({ from, to } = rangeFor(view, anchor));
    }
    setLoading(true);
    listSchedules({ from: from.toISOString(), to: to.toISOString() })
      .then((data) => {
        setSchedules(data);
        loadedOnceRef.current = true;
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }

  // 月表示は monthList、それ以外は view/anchor でリロード。
  useEffect(reload, [view, anchor, monthList]);

  function shift(n: number) {
    if (view === 'day') setAnchor((a) => addDays(a, n));
    else if (view === 'week') setAnchor((a) => addDays(a, n * MULTI_DAY_COUNT));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1));
  }

  async function onDelete(id: string) {
    if (!(await confirm('この予定を削除しますか？'))) return;
    try {
      await deleteSchedule(id);
      reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // 日を跨ぐ予定(例: 前日23:00〜当日1:00)もその日の分として拾えるよう、
  // start_atが当日かどうかではなく「その日と重なるか」で判定する(バグ修正)。
  function schedulesOnDay(day: Date): Schedule[] {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    return schedules.filter((s) => new Date(s.start_at) < dayEnd && new Date(s.end_at) > dayStart);
  }

  const weekDays =
    view === 'week' ? Array.from({ length: MULTI_DAY_COUNT }, (_, i) => addDays(startOfDay(anchor), i)) : [startOfDay(anchor)];

  // 年月バーが下部ボタンと重なるバグ・月表示で画面全体がスクロールしてしまうバグの修正
  // (議事録要望): main自体を画面高に固定しoverflow:hiddenにすることで、上部の
  // タブ/前後移動バーは常に画面内に留まり、カレンダー本体(月表示のmonthScrollRef/
  // 週日表示のTimeGrid)だけが内部スクロールするようにする。
  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 56px)', overflow: 'hidden' }}>
      {/* カレンダーの表示範囲を広げるため、月/3日/日の切替はタブ行を独立させず
          ヘッダー内に同居させて縦スペースを節約する(議事録要望)。 */}
      <ScreenHeader>
        <h1 style={{ margin: 0, fontSize: 20 }}>スケジュール</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                background: view === v ? 'var(--color-primary)' : '#fff',
                color: view === v ? '#fff' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {v === 'month' ? '月' : v === 'week' ? '3日' : '日'}
            </button>
          ))}
        </div>
      </ScreenHeader>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, gap: 8 }}>
        <button onClick={() => shift(-1)} style={{ padding: '0 14px' }}>
          ←
        </button>
        <button
          onClick={() => setAnchor(new Date())}
          style={{ padding: '4px 10px', fontSize: 13, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          今日
        </button>
        <strong style={{ flex: 1, textAlign: 'center', fontSize: 15 }}>{fmtRangeLabel(view, anchor)}</strong>
        <button onClick={() => shift(1)} style={{ padding: '0 14px' }}>
          →
        </button>
      </div>

      {error && <p style={{ color: '#c0392b', marginTop: 12 }}>{error}</p>}

      {loading && !loadedOnceRef.current ? (
        <p style={{ marginTop: 16 }}>読み込み中…</p>
      ) : view === 'month' ? (
        // 月表示は縦に連続表示(無限スクロール)。上下端で前後の月を継ぎ足す(回答A)。
        <div
          ref={monthScrollRef}
          onScroll={onMonthScroll}
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 16 }}
        >
          {monthList.map((m) => (
            <div key={monthKey(m)}>
              {/* 上部の今日/前後移動バーの年月表示と紛らわしく見える(実機レビュー指摘)ため、
                  背景色/枠で区別できるチップ状にして「今表示中の月」ラベルだと分かるようにする。 */}
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  display: 'flex',
                  padding: '6px 0',
                  background: 'var(--color-bg)',
                }}
              >
                <span
                  style={{
                    background: 'var(--color-primary-light)',
                    border: '1px solid var(--color-primary-border)',
                    borderRadius: 999,
                    padding: '2px 10px',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--color-primary-dark)',
                  }}
                >
                  {m.getFullYear()}年{m.getMonth() + 1}月
                </span>
              </div>
              <MonthGrid
                anchor={m}
                schedules={schedules}
                fixedHeight
                onSelectDay={(d) => {
                  setAnchor(d);
                  setView('day');
                }}
                onSelectSchedule={(s) => setEditing(s)}
              />
            </div>
          ))}
        </div>
      ) : (
        // TimeGrid自身のmaxHeight(内部スクロール)より画面が小さい端末でも下部ボタンが
        // 隠れないよう、flex:1のラッパーで包んで必要なら二重にスクロール可能にする。
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <TimeGrid
            days={weekDays}
            schedulesOnDay={schedulesOnDay}
            customers={customers}
            onSelectSchedule={(s) => setEditing(s)}
            onSelectSlot={(dateTime) => {
              setPresetSlot(dateTime);
              setEditing('new');
            }}
          />
        </div>
      )}

      {/* 操作ボタンを画面下部(親指の届く位置)に配置(議事録『review(2回目)』要望)。
          mainは既にcalc(100dvh - 56px)で下部ナビ分を引いたflex columnのため、ここでの
          sticky/bottom指定は不要かつ余白の原因になっていた(実機レビュー指摘)。通常のflex子要素として
          カレンダー領域(flex:1)のすぐ下・画面最下部に固定する。 */}
      <div style={{ display: 'flex', gap: 8, flex: 'none', paddingTop: 12, paddingBottom: 8, background: 'var(--color-bg)' }}>
        <button
          onClick={openProposal}
          disabled={proposalLoading}
          style={{ flex: 1, padding: 12, fontSize: 14, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {proposalLoading ? '作成中…' : '日程調整の文章'}
        </button>
        <button
          onClick={() => {
            setPresetSlot(null);
            setEditing('new');
          }}
          style={{ flex: 1, padding: 12, fontSize: 14 }}
        >
          + 予定
        </button>
      </div>

      {editing && profile && (
        <ScheduleForm
          initial={editing === 'new' ? null : editing}
          presetSlot={editing === 'new' ? presetSlot : null}
          customers={customers}
          onCustomerCreated={(c) => setCustomers((prev) => [c, ...prev])}
          locationHistory={locationHistory}
          profile={profile}
          onClose={() => {
            setPresetSlot(null);
            setEditing(null);
          }}
          onDelete={editing !== 'new' ? () => onDelete((editing as Schedule).id).then(() => setEditing(null)) : undefined}
          onSaved={(newCustomer) => {
            setPresetSlot(null);
            setEditing(null);
            reload();
            // その場で新規登録したつながりがあれば、詳しい登録を提案する(議事録要望)。
            if (newCustomer) setProposeCustomer(newCustomer);
          }}
        />
      )}

      {proposeCustomer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(42,38,34,0.4)', display: 'flex', alignItems: 'flex-end', zIndex: 200 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: '16px 16px 0 0', padding: 20, width: '100%', display: 'grid', gap: 10 }}>
            <strong>{proposeCustomer.name}さんのことを登録しましょう</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)' }}>
              どんな方か記録しておくと、後からのおさらいやAI相談に役立ちます。
            </p>
            <button
              type="button"
              onClick={() => navigate(`/customers/${proposeCustomer.id}/edit?register=1`)}
              style={{ padding: 12 }}
            >
              テキストで登録する
            </button>
            <button
              type="button"
              onClick={() => navigate(`/osarai?customerId=${proposeCustomer.id}&mode=register`)}
              style={{ padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              AIと対話して登録する
            </button>
            <button
              type="button"
              onClick={() => setProposeCustomer(null)}
              style={{ padding: 8, background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 13 }}
            >
              今はしない
            </button>
          </div>
        </div>
      )}
      {proposal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(42,38,34,0.4)',
            display: 'flex',
            alignItems: 'flex-end',
            zIndex: 200,
          }}
        >
          <div
            style={{
              background: 'var(--color-surface)',
              borderRadius: '16px 16px 0 0',
              padding: 20,
              width: '100%',
              display: 'grid',
              gap: 10,
            }}
          >
            <strong>日程調整の文章</strong>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)' }}>
              直近7日間の空き時間から候補を作成しました。コピーしてLINE等で送れます。
            </p>
            <textarea
              readOnly
              value={proposal.text}
              rows={8}
              style={{ width: '100%', padding: 10, fontSize: 14, lineHeight: 1.6, resize: 'none' }}
            />
            {proposal.copyMsg && <p style={{ margin: 0, fontSize: 13 }}>{proposal.copyMsg}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setProposal(null)}
                style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                閉じる
              </button>
              <button type="button" onClick={onCopyProposal} style={{ flex: 1, padding: 12 }}>
                コピー
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </main>
  );
}

// ========== 月ビュー: 日付グリッド。予定のタイトル・開始時刻を表示し、タップで日ビュー/編集へ ==========
// 画面下部に余白ができないよう、グリッド全体をflex:1で画面高さいっぱいにストレッチする
// (議事録『review(2回目)』要望)。
const MONTH_MAX_EVENTS_PER_CELL = 2;

function MonthGrid({
  anchor,
  schedules,
  onSelectDay,
  onSelectSchedule,
  fixedHeight = false,
}: {
  anchor: Date;
  schedules: Schedule[];
  onSelectDay: (d: Date) => void;
  onSelectSchedule: (s: Schedule) => void;
  // 無限スクロール(複数月を縦に積む)時は各月を固定高にする。単月表示時はflex:1で画面いっぱい。
  fixedHeight?: boolean;
}) {
  const gridStart = startOfWeek(startOfMonth(anchor));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  // 日を跨ぐ予定(例: 末日23:00→翌日1:00)は開始日だけでなく、跨いだ各日のセルにも表示する
  // (バグ修正: 従来はstart_atの日にしか出ず、終了日側のセルから欠落していた)。
  // グリッドに現れる日(days)の範囲で、各予定が重なる日すべてに割り当てる。
  // 無限スクロールで複数月分のMonthGridが同時にマウントされるため、schedules/月が
  // 変わらない再レンダー(例: 他の月のスクロールによる親の再描画)ではこの計算を
  // 使い回す(前後移動時のもたつき軽減・議事録要望)。
  const itemsByDay = useMemo(() => {
    const map = new Map<string, Schedule[]>();
    const sorted = [...schedules].sort((a, b) => +new Date(a.start_at) - +new Date(b.start_at));
    for (const d of days) {
      const cellStart = startOfDay(d);
      const cellEnd = addDays(cellStart, 1);
      for (const s of sorted) {
        if (new Date(s.start_at) < cellEnd && new Date(s.end_at) > cellStart) {
          const key = dayKey(d);
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(s);
        }
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, gridStart.getTime()]);

  return (
    <div style={fixedHeight ? { marginTop: 8 } : { marginTop: 12, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        {WEEKDAY_JA.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div
        style={{
          ...(fixedHeight ? {} : { flex: 1 }),
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridTemplateRows: fixedHeight ? 'repeat(6, 76px)' : 'repeat(6, 1fr)',
          gap: 2,
        }}
      >
        {days.map((d, i) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          const items = itemsByDay.get(key) ?? [];
          const isToday = isSameDay(d, today);
          return (
            <div
              key={i}
              onClick={() => onSelectDay(d)}
              style={{
                padding: 3,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                background: '#fff',
                border: isToday ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                borderRadius: 8,
                opacity: inMonth ? 1 : 0.4,
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? 'var(--color-primary)' : 'var(--color-text)' }}>
                {d.getDate()}
              </span>
              {items.slice(0, MONTH_MAX_EVENTS_PER_CELL).map((s) => {
                // 日跨ぎ予定: 開始日は時刻+タイトル、継続日(翌日以降)は⇢マーカー+タイトルで表す。
                const startsToday = isSameDay(new Date(s.start_at), d);
                return (
                  <button
                    key={`${s.id}-${key}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectSchedule(s);
                    }}
                    style={{
                      marginTop: 1,
                      padding: '1px 3px',
                      background: categoryColor(s.category),
                      color: '#fff',
                      border: 'none',
                      borderRadius: 3,
                      fontSize: 9,
                      lineHeight: 1.3,
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      minHeight: 'auto',
                      height: 'auto',
                    }}
                  >
                    {startsToday
                      ? `${new Date(s.start_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} ${s.title}`
                      : `⇢ ${s.title}`}
                  </button>
                );
              })}
              {items.length > MONTH_MAX_EVENTS_PER_CELL && (
                <span style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>
                  +{items.length - MONTH_MAX_EVENTS_PER_CELL}件
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ========== 週/日ビュー共通: 時間軸グリッド。予定を開始/終了時刻の位置・高さで配置し、
// 重なりは横並びの列に分割して表示する(AC②③④) ==========
function TimeGrid({
  days,
  schedulesOnDay,
  customers,
  onSelectSchedule,
  onSelectSlot,
}: {
  days: Date[];
  schedulesOnDay: (d: Date) => Schedule[];
  customers: Customer[];
  onSelectSchedule: (s: Schedule) => void;
  onSelectSlot: (dateTime: Date) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 初期スクロール位置を8時付近に(全日表示だが業務時間帯が見えるように)
    scrollRef.current?.scrollTo({ top: HOUR_HEIGHT * 7 });
  }, [days[0]?.toDateString()]);

  const today = new Date();

  return (
    // バグ修正: 従来は「overflow:hidden の外側div」の中に「overflowY:auto の内側div」を
    // ネストしており、スクロール中に日付ヘッダー(position:sticky)や縦線(border)が
    // 消える/崩れることがあった(sticky位置計算の基準となるスクロール祖先が二重に
    // なっていたため)。スクロールする要素自体にborder/角丸/背景を持たせ、
    // overflow:hiddenの外側wrapperを廃止して一枚のdivに統合する。
    <div
      ref={scrollRef}
      style={{
        marginTop: 12,
        display: 'flex',
        width: '100%',
        maxHeight: 520,
        overflowY: 'auto',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        background: '#fff',
      }}
    >
      {/* 時刻ラベル列 */}
      <div style={{ width: 36, flexShrink: 0, borderRight: '1px solid var(--color-border)' }}>
          <div style={{ height: 28 }} />
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              style={{
                height: HOUR_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                fontSize: 10,
                color: 'var(--color-text-muted)',
                paddingRight: 4,
                boxSizing: 'border-box',
                borderTop: '1px solid #f0ece5',
              }}
            >
              {h}
            </div>
          ))}
        </div>
        {/* 日ごとの列 */}
        {days.map((day) => {
          const items = schedulesOnDay(day);
          const layout = layoutOverlaps(items);
          const isToday = isSameDay(day, today);
          // 土日の色分け(議事録要望)。土=青、日=赤。当日強調(オレンジ)を優先する。
          const dow = day.getDay();
          const weekendColor = dow === 0 ? '#c0392b' : dow === 6 ? '#3b82f6' : undefined;
          return (
            <div key={day.toDateString()} style={{ flex: 1, minWidth: days.length > 1 ? 44 : undefined, position: 'relative', borderRight: '1px solid #f0ece5' }}>
              <div
                style={{
                  height: 28,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  fontSize: 11,
                  color: isToday ? 'var(--color-primary)' : weekendColor ?? 'var(--color-text-muted)',
                  fontWeight: isToday ? 700 : 400,
                  position: 'sticky',
                  top: 0,
                  background: '#fff',
                  zIndex: 1,
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                {WEEKDAY_JA[day.getDay()]} {day.getDate()}
              </div>
              <div
                style={{ position: 'relative', height: HOUR_HEIGHT * 24 }}
                onClick={(e) => {
                  // 予定の無い空き枠をタップした時だけ、その日時を選択済みで新規作成モーダルを開く
                  // (既存の予定ブロックのタップはそちら側のonClickが個別に処理する)。
                  if (e.target !== e.currentTarget) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const rawHour = (e.clientY - rect.top) / HOUR_HEIGHT;
                  const minutes = rawHour % 1 >= 0.5 ? 30 : 0;
                  const slot = new Date(day);
                  slot.setHours(Math.max(0, Math.min(23, Math.floor(rawHour))), minutes, 0, 0);
                  onSelectSlot(slot);
                }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ position: 'absolute', top: h * HOUR_HEIGHT, left: 0, right: 0, borderTop: '1px solid #f7f4ef' }} />
                ))}
                {layout.map(({ schedule, col, cols }) => {
                  const start = new Date(schedule.start_at);
                  const end = new Date(schedule.end_at);
                  const dayStart = startOfDay(day);
                  const dayEnd = addDays(dayStart, 1);
                  // 日を跨ぐ予定は、この日の枠(0:00〜24:00)にクリップして表示する
                  // (バグ修正: 従来はクリップせず実際の長さで高さを取っていたため、
                  // 24時を越える分がこの日の列からはみ出して描画されていた)。
                  const continuesBefore = start < dayStart;
                  const continuesAfter = end > dayEnd;
                  const segStartMin = continuesBefore ? 0 : start.getHours() * 60 + start.getMinutes();
                  const segEndMin = continuesAfter ? 24 * 60 : (+end - +dayStart) / 60000;
                  const durMin = Math.max(20, segEndMin - segStartMin);
                  const top = (segStartMin / 60) * HOUR_HEIGHT;
                  const height = (durMin / 60) * HOUR_HEIGHT;
                  const widthPct = 100 / cols;
                  const customer = customers.find((c) => c.id === schedule.customer_id);
                  return (
                    <button
                      key={`${schedule.id}-${day.toDateString()}`}
                      onClick={() => onSelectSchedule(schedule)}
                      title={continuesBefore || continuesAfter ? '日をまたぐ予定' : undefined}
                      style={{
                        position: 'absolute',
                        top,
                        height,
                        left: `${col * widthPct}%`,
                        width: `${widthPct}%`,
                        background: categoryColor(schedule.category),
                        color: '#fff',
                        // 前後に続きがある側は角丸を付けない(切れている見た目にする)ことで
                        // 日を跨いでいることを視覚的に示す。
                        border: '1px solid #fff',
                        borderRadius: `${continuesBefore ? 0 : 4}px ${continuesBefore ? 0 : 4}px ${continuesAfter ? 0 : 4}px ${continuesAfter ? 0 : 4}px`,
                        padding: 3,
                        fontSize: 10,
                        textAlign: 'left',
                        overflow: 'hidden',
                        display: 'block',
                      }}
                    >
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {continuesBefore && '⇡ '}
                        {schedule.category && `[${schedule.category}] `}
                        {schedule.title}
                        {continuesAfter && ' ⇣'}
                      </div>
                      {customer && <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{customer.name}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
  );
}

function ScheduleForm({
  initial,
  presetSlot,
  customers,
  onCustomerCreated,
  locationHistory,
  profile,
  onClose,
  onSaved,
  onDelete,
}: {
  initial: Schedule | null;
  presetSlot?: Date | null;
  customers: Customer[];
  onCustomerCreated: (customer: Customer) => void;
  locationHistory: string[];
  profile: Pick<Profile, 'id' | 'org_id'>;
  onClose: () => void;
  // 保存成功時、この予定作成中にその場で新規登録した顧客があれば渡す(登録提案モーダル用)。
  onSaved: (newlyCreatedCustomer?: Customer) => void;
  onDelete?: () => void | Promise<void>;
}) {
  // カレンダーの空き枠をタップして新規作成した場合は、その日時を選択済みにする
  // (議事録要望)。それ以外(+予定ボタン等)は従来通り現在時刻を既定にする。
  const defaultStart = presetSlot ?? new Date();
  const inHourLater = new Date(defaultStart.getTime() + 60 * 60 * 1000);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startAt, setStartAt] = useState(initial ? toDatetimeLocal(initial.start_at) : toDatetimeLocal(defaultStart.toISOString()));
  const [endAt, setEndAt] = useState(initial ? toDatetimeLocal(initial.end_at) : toDatetimeLocal(inHourLater.toISOString()));
  const [customerId, setCustomerId] = useState(initial?.customer_id ?? '');
  const [customerSearch, setCustomerSearch] = useState('');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [mode, setMode] = useState(initial?.mode ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerNeeds, setNewCustomerNeeds] = useState('');
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomerError, setNewCustomerError] = useState<string | null>(null);
  // つながりを追加(自己紹介解析): CustomerForm.tsxのテキスト/画像解析と同じAPIを使う簡易版。
  const [analyzeText, setAnalyzeText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const analyzeFileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // このフォームでその場で新規登録した顧客(保存後に登録提案モーダルを出すかの判定に使う)。
  const createdCustomerRef = useRef<Customer | null>(null);
  useEscapeKey(onClose);

  // 予定作成のその場で新しい顧客を登録できるようにする(既存顧客一覧に無い相手の場合、
  // 一旦顧客登録画面へ離脱すると入力中の予定内容が失われるため。議事録要望)。
  // つながり登録画面(CustomerForm.tsx)と同じ自己紹介テキスト/画像解析を使い、
  // 名前だけでなくニーズ・温度感も抽出したうえで登録する(議事録要望「つながりを追加」)。
  async function onAnalyzeText() {
    if (!analyzeText.trim() || analyzing) return;
    setAnalyzing(true);
    setNewCustomerError(null);
    try {
      const r = await analyzeCustomerText(analyzeText);
      if (r.name) setNewCustomerName(r.name);
      if (r.needs) setNewCustomerNeeds(r.needs);
    } catch (e) {
      setNewCustomerError(String(e instanceof Error ? e.message : e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function onAnalyzeImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (analyzeFileRef.current) analyzeFileRef.current.value = '';
    if (!file || analyzing) return;
    setAnalyzing(true);
    setNewCustomerError(null);
    try {
      const r = await analyzeCustomerImage(file);
      if (r.name) setNewCustomerName(r.name);
      if (r.needs) setNewCustomerNeeds(r.needs);
    } catch (e) {
      setNewCustomerError(String(e instanceof Error ? e.message : e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleCreateCustomer() {
    const name = newCustomerName.trim();
    if (!name || creatingCustomer) return;
    setCreatingCustomer(true);
    setNewCustomerError(null);
    try {
      const created = await createCustomer(
        { name, needs: newCustomerNeeds.trim() || null, relationType: null },
        profile,
      );
      onCustomerCreated(created);
      createdCustomerRef.current = created;
      setCustomerId(created.id);
      setAddingCustomer(false);
      setNewCustomerName('');
      setNewCustomerNeeds('');
      setAnalyzeText('');
    } catch (e) {
      setNewCustomerError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreatingCustomer(false);
    }
  }

  async function handleDelete() {
    if (!onDelete || deleting) return; // 連打による二重削除リクエストを防止
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || deleting) return; // 連打による二重送信を防止(ボタンのdisabledに加えて関数内でもガード)
    // 顧客が選択されていればタイトル未入力でも保存できる(顧客名を自動でタイトルにする)。
    // 顧客未選択の場合はタイトル必須(議事録『review(2回目)』要望)。
    const selectedCustomerName = customers.find((c) => c.id === customerId)?.name;
    if (!title.trim() && !customerId) {
      setError('タイトルを入力するか、つながりを選択してください。');
      return;
    }
    setSaving(true);
    setError(null);
    const input: ScheduleInput = {
      title: title.trim() || selectedCustomerName || '',
      customerId: customerId || null,
      category: category || null,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      notes: notes.trim() || null,
      mode: mode || null,
      location: location.trim() || null,
    };
    try {
      if (initial) await updateSchedule(initial.id, input);
      else await createSchedule(input, profile);
      // その場で新規登録した顧客がこの予定に紐付いていれば、登録提案モーダル用に渡す。
      const created = createdCustomerRef.current;
      onSaved(created && created.id === customerId ? created : undefined);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(42,38,34,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
        zIndex: 200,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: 'var(--color-surface)',
          borderRadius: '16px 16px 0 0',
          padding: 20,
          width: '100%',
          boxSizing: 'border-box',
          display: 'grid',
          gap: 10,
          // 項目が増えて画面幅/高さを超えても内容が切れないよう内部スクロールにする(議事録要望)。
          maxHeight: '90dvh',
          overflowY: 'auto',
        }}
      >
        <strong>{initial ? '予定を編集' : '予定を追加'}</strong>
        {/* 顧客プルダウンを最上部に移動(議事録要望・タイトルより先に選べるように) */}
        <label>
          つながり
          <input
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            placeholder="名前で絞り込み…"
            style={{ width: '100%', padding: 10, marginTop: 4, marginBottom: 6 }}
          />
          <select
            value={customerId ?? ''}
            onChange={(e) => setCustomerId(e.target.value)}
            style={{ width: '100%', padding: 10 }}
          >
            <option value="">指定しない</option>
            {customers
              .filter(
                (c) =>
                  c.id === customerId || // 選択中の顧客は絞り込みで隠れないよう常に残す
                  c.name.toLowerCase().includes(customerSearch.trim().toLowerCase()),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        {addingCustomer ? (
          <div style={{ display: 'grid', gap: 6, background: 'var(--color-primary-light)', border: '1px solid var(--color-primary-border)', borderRadius: 10, padding: 10 }}>
            <strong style={{ fontSize: 14 }}>つながりを追加</strong>
            <input
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
              placeholder="名前"
              style={{ width: '100%', padding: 10 }}
            />
            {/* つながり登録画面(CustomerForm.tsx)と同じ自己紹介テキスト/画像解析(議事録要望)。 */}
            <textarea
              value={analyzeText}
              onChange={(e) => setAnalyzeText(e.target.value)}
              placeholder="紹介文や自己紹介の文面を貼り付け…（任意）"
              rows={2}
              disabled={analyzing}
              style={{ width: '100%', padding: 10, fontSize: 13, fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={onAnalyzeText}
                disabled={analyzing || !analyzeText.trim()}
                style={{ flex: 1, padding: 8, fontSize: 13 }}
              >
                {analyzing ? '解析中…' : 'テキストから解析'}
              </button>
              <button
                type="button"
                onClick={() => analyzeFileRef.current?.click()}
                disabled={analyzing}
                style={{ flex: 1, padding: 8, fontSize: 13 }}
              >
                画像から解析
              </button>
            </div>
            <input ref={analyzeFileRef} type="file" accept="image/*" onChange={onAnalyzeImage} style={{ display: 'none' }} />
            {newCustomerNeeds && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>
                {`ニーズ: ${newCustomerNeeds}`}
              </p>
            )}
            {newCustomerError && <p style={{ color: '#c0392b', margin: 0, fontSize: 13 }}>{newCustomerError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setAddingCustomer(false);
                  setNewCustomerName('');
                  setNewCustomerNeeds('');
                  setAnalyzeText('');
                  setNewCustomerError(null);
                }}
                style={{ flex: 1, padding: 10, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleCreateCustomer}
                disabled={!newCustomerName.trim() || creatingCustomer}
                style={{ flex: 1, padding: 10 }}
              >
                {creatingCustomer ? '登録中…' : '登録して選択'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingCustomer(true)}
            style={{ padding: 10, background: '#fff', border: '1px dashed var(--color-border)', color: 'var(--color-primary)' }}
          >
            + 新しいつながりを登録
          </button>
        )}
        {!customerId && (
          <label>
            タイトル <RequiredMark />
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              style={{ width: '100%', padding: 10, marginTop: 4 }}
            />
          </label>
        )}
        <label>
          カテゴリ
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          >
            <option value="">指定しない</option>
            {SCHEDULE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          開始 <RequiredMark />
          {/* step=600秒=10分刻み。スマホのネイティブ日時ピッカーが10分単位になる。 */}
          <input
            type="datetime-local"
            step={600}
            value={startAt}
            onChange={(e) => {
              // 開始を変更したら終了を開始+1時間に自動設定する(既存の終了時刻は保持しない・
              // 議事録要望)。
              const v = e.target.value;
              setStartAt(v);
              const d = new Date(v);
              if (!Number.isNaN(d.getTime())) {
                setEndAt(toDatetimeLocal(new Date(d.getTime() + 60 * 60 * 1000).toISOString()));
              }
            }}
            required
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
        </label>
        <label>
          終了 <RequiredMark />
          <input
            type="datetime-local"
            step={600}
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
            required
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
        </label>
        <label>
          対面/オンライン
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: '100%', padding: 10, marginTop: 4 }}>
            <option value="">指定しない</option>
            {SCHEDULE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          場所
          <input
            list="schedule-location-history"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="過去に入力した場所を選ぶか、新しく入力…"
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
          <datalist id="schedule-location-history">
            {locationHistory.map((loc) => (
              <option key={loc} value={loc} />
            ))}
          </datalist>
        </label>
        <label>
          メモ
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ width: '100%', padding: 10, marginTop: 4, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </label>
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            キャンセル
          </button>
          <button type="submit" disabled={saving || deleting} style={{ flex: 1, padding: 12 }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        {onDelete && (
          // 保存/キャンセルから離し、控えめな見た目(枠なしのテキストリンク)にすることで
          // 誤タップを防ぐ(議事録要望・確認ダイアログは既存のonDelete側で挟んでいる)。
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || saving}
            style={{
              marginTop: 16,
              padding: 8,
              background: 'none',
              border: 'none',
              color: '#c0392b',
              textDecoration: 'underline',
              fontSize: 13,
              justifySelf: 'center',
            }}
          >
            {deleting ? '削除中…' : 'この予定を削除'}
          </button>
        )}
      </form>
    </div>
  );
}
