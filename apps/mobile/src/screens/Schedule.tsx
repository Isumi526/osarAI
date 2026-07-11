// スケジュール管理（月/週/日 グリッドカレンダー・顧客紐付け任意）。§14フェーズ後追加。
// Google/Appleカレンダー品質のグリッドUIに刷新（旧: アジェンダ形式のリスト表示）。
import { useEffect, useRef, useState } from 'react';
import { listCustomers, getMyProfile, type Customer, type Profile } from '../lib/db.js';
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

type ViewMode = 'month' | 'week' | 'day';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_HEIGHT = 56; // 1時間あたりの高さ(px)。0-24時の全日をスクロール表示(Google/Appleカレンダー同様)。
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

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

export function SchedulePage() {
  const [view, setView] = useState<ViewMode>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locationHistory, setLocationHistory] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [proposal, setProposal] = useState<{ text: string; copyMsg: string | null } | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

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
    const { from, to } = rangeFor(view, anchor);
    setLoading(true);
    listSchedules({ from: from.toISOString(), to: to.toISOString() })
      .then(setSchedules)
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [view, anchor]);

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

  function schedulesOnDay(day: Date): Schedule[] {
    return schedules.filter((s) => isSameDay(new Date(s.start_at), day));
  }

  const weekDays =
    view === 'week' ? Array.from({ length: MULTI_DAY_COUNT }, (_, i) => addDays(startOfDay(anchor), i)) : [startOfDay(anchor)];

  return (
    <main className="screen" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 56px)' }}>
      <header className="screen-header">
        <h1 style={{ margin: 0, fontSize: 20 }}>スケジュール</h1>
      </header>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              flex: 1,
              padding: 8,
              background: view === v ? 'var(--color-primary)' : '#fff',
              color: view === v ? '#fff' : 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          >
            {v === 'month' ? '月' : v === 'week' ? '週' : '日'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 8 }}>
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

      {loading ? (
        <p style={{ marginTop: 16 }}>読み込み中…</p>
      ) : view === 'month' ? (
        <MonthGrid
          anchor={anchor}
          schedules={schedules}
          onSelectDay={(d) => {
            setAnchor(d);
            setView('day');
          }}
          onSelectSchedule={(s) => setEditing(s)}
        />
      ) : (
        <TimeGrid
          days={weekDays}
          schedulesOnDay={schedulesOnDay}
          customers={customers}
          onSelectSchedule={(s) => setEditing(s)}
        />
      )}

      {/* 操作ボタンを画面下部(親指の届く位置)に配置(議事録『review(2回目)』要望) */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 12, paddingBottom: 8, position: 'sticky', bottom: 56, background: 'var(--color-bg)' }}>
        <button
          onClick={openProposal}
          disabled={proposalLoading}
          style={{ flex: 1, padding: 12, fontSize: 14, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {proposalLoading ? '作成中…' : '日程調整の文章'}
        </button>
        <button onClick={() => setEditing('new')} style={{ flex: 1, padding: 12, fontSize: 14 }}>
          + 予定
        </button>
      </div>

      {editing && profile && (
        <ScheduleForm
          initial={editing === 'new' ? null : editing}
          customers={customers}
          locationHistory={locationHistory}
          profile={profile}
          onClose={() => setEditing(null)}
          onDelete={editing !== 'new' ? () => onDelete((editing as Schedule).id).then(() => setEditing(null)) : undefined}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
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
}: {
  anchor: Date;
  schedules: Schedule[];
  onSelectDay: (d: Date) => void;
  onSelectSchedule: (s: Schedule) => void;
}) {
  const gridStart = startOfWeek(startOfMonth(anchor));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  const itemsByDay = new Map<string, Schedule[]>();
  for (const s of [...schedules].sort((a, b) => +new Date(a.start_at) - +new Date(b.start_at))) {
    const d = new Date(s.start_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!itemsByDay.has(key)) itemsByDay.set(key, []);
    itemsByDay.get(key)!.push(s);
  }

  return (
    <div style={{ marginTop: 12, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
        {WEEKDAY_JA.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: 'repeat(6, 1fr)', gap: 2 }}>
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
              {items.slice(0, MONTH_MAX_EVENTS_PER_CELL).map((s) => (
                <button
                  key={s.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSchedule(s);
                  }}
                  style={{
                    marginTop: 1,
                    padding: '1px 3px',
                    background: 'var(--color-primary-light)',
                    color: 'var(--color-primary)',
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
                  {new Date(s.start_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} {s.title}
                </button>
              ))}
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
}: {
  days: Date[];
  schedulesOnDay: (d: Date) => Schedule[];
  customers: Customer[];
  onSelectSchedule: (s: Schedule) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 初期スクロール位置を8時付近に(全日表示だが業務時間帯が見えるように)
    scrollRef.current?.scrollTo({ top: HOUR_HEIGHT * 7 });
  }, [days[0]?.toDateString()]);

  const today = new Date();

  return (
    <div style={{ marginTop: 12, display: 'flex', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div ref={scrollRef} style={{ display: 'flex', width: '100%', maxHeight: 520, overflowY: 'auto' }}>
        {/* 時刻ラベル列 */}
        <div style={{ width: 36, flexShrink: 0, borderRight: '1px solid var(--color-border)' }}>
          <div style={{ height: 28 }} />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} style={{ height: HOUR_HEIGHT, fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'right', paddingRight: 4, boxSizing: 'border-box', borderTop: '1px solid #f0ece5' }}>
              {h}
            </div>
          ))}
        </div>
        {/* 日ごとの列 */}
        {days.map((day) => {
          const items = schedulesOnDay(day);
          const layout = layoutOverlaps(items);
          const isToday = isSameDay(day, today);
          return (
            <div key={day.toDateString()} style={{ flex: 1, minWidth: days.length > 1 ? 44 : undefined, position: 'relative', borderRight: '1px solid #f0ece5' }}>
              <div
                style={{
                  height: 28,
                  textAlign: 'center',
                  fontSize: 11,
                  color: isToday ? 'var(--color-primary)' : 'var(--color-text-muted)',
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
              <div style={{ position: 'relative', height: HOUR_HEIGHT * 24 }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ position: 'absolute', top: h * HOUR_HEIGHT, left: 0, right: 0, borderTop: '1px solid #f7f4ef' }} />
                ))}
                {layout.map(({ schedule, col, cols }) => {
                  const start = new Date(schedule.start_at);
                  const end = new Date(schedule.end_at);
                  const startMin = start.getHours() * 60 + start.getMinutes();
                  const durMin = Math.max(20, (+end - +start) / 60000);
                  const top = (startMin / 60) * HOUR_HEIGHT;
                  const height = (durMin / 60) * HOUR_HEIGHT;
                  const widthPct = 100 / cols;
                  const customer = customers.find((c) => c.id === schedule.customer_id);
                  return (
                    <button
                      key={schedule.id}
                      onClick={() => onSelectSchedule(schedule)}
                      style={{
                        position: 'absolute',
                        top,
                        height,
                        left: `${col * widthPct}%`,
                        width: `${widthPct}%`,
                        background: 'var(--color-primary)',
                        color: '#fff',
                        border: '1px solid #fff',
                        borderRadius: 4,
                        padding: 3,
                        fontSize: 10,
                        textAlign: 'left',
                        overflow: 'hidden',
                        display: 'block',
                      }}
                    >
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {schedule.category && `[${schedule.category}] `}
                        {schedule.title}
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
    </div>
  );
}

function ScheduleForm({
  initial,
  customers,
  locationHistory,
  profile,
  onClose,
  onSaved,
  onDelete,
}: {
  initial: Schedule | null;
  customers: Customer[];
  locationHistory: string[];
  profile: Pick<Profile, 'id' | 'org_id'>;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const now = new Date();
  const inHourLater = new Date(now.getTime() + 60 * 60 * 1000);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startAt, setStartAt] = useState(initial ? toDatetimeLocal(initial.start_at) : toDatetimeLocal(now.toISOString()));
  const [endAt, setEndAt] = useState(initial ? toDatetimeLocal(initial.end_at) : toDatetimeLocal(inHourLater.toISOString()));
  const [customerId, setCustomerId] = useState(initial?.customer_id ?? '');
  const [customerSearch, setCustomerSearch] = useState('');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [mode, setMode] = useState(initial?.mode ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError('タイトルを入力するか、顧客を選択してください。');
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
      onSaved();
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
          display: 'grid',
          gap: 10,
        }}
      >
        <strong>{initial ? '予定を編集' : '予定を追加'}</strong>
        <label>
          タイトル{customerId ? '（任意・空欄なら顧客名を使用）' : ''}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required={!customerId}
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
        </label>
        <label>
          開始
          <input
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
            required
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
        </label>
        <label>
          終了
          <input
            type="datetime-local"
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
            required
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          />
        </label>
        <label>
          カテゴリ（任意）
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
          場所（任意）
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
          対面/オンライン（任意）
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
          顧客（任意）
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
        <label>
          メモ（任意）
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
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || saving}
            style={{ padding: 10, background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}
          >
            {deleting ? '削除中…' : 'この予定を削除'}
          </button>
        )}
      </form>
    </div>
  );
}
