// スケジュール管理（月/週/日ビュー・顧客紐付け任意）。§14フェーズ後追加。
import { useEffect, useState } from 'react';
import { listCustomers, getMyProfile, type Customer, type Profile } from '../lib/db.js';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  type Schedule,
  type ScheduleInput,
} from '../lib/schedules.js';
import { useConfirm } from '../components/ConfirmDialog.js';

type ViewMode = 'month' | 'week' | 'day';

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
function rangeFor(view: ViewMode, anchor: Date): { from: Date; to: Date } {
  if (view === 'day') return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === 'week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 7) };
  const from = startOfMonth(anchor);
  const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { from, to };
}
function fmtRangeLabel(view: ViewMode, anchor: Date): string {
  if (view === 'day') return anchor.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  if (view === 'week') {
    const s = startOfWeek(anchor);
    const e = addDays(s, 6);
    return `${s.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })} 〜 ${e.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })}`;
  }
  return anchor.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
}
function dateKey(d: Date): string {
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
}
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulePage() {
  const [view, setView] = useState<ViewMode>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    getMyProfile().then(setProfile);
    listCustomers({}).then(setCustomers).catch(() => undefined);
  }, []);

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
    else if (view === 'week') setAnchor((a) => addDays(a, n * 7));
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

  const groups = new Map<string, Schedule[]>();
  for (const s of schedules) {
    const key = dateKey(new Date(s.start_at));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  return (
    <main className="screen">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>スケジュール</h1>
        <button onClick={() => setEditing('new')} style={{ padding: '0 14px' }}>
          + 予定
        </button>
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <button onClick={() => shift(-1)} style={{ padding: '0 14px' }}>
          ←
        </button>
        <strong>{fmtRangeLabel(view, anchor)}</strong>
        <button onClick={() => shift(1)} style={{ padding: '0 14px' }}>
          →
        </button>
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {loading ? (
        <p style={{ marginTop: 16 }}>読み込み中…</p>
      ) : schedules.length === 0 ? (
        <p style={{ marginTop: 16, color: 'var(--color-text-muted)' }}>この期間の予定はありません。</p>
      ) : (
        [...groups.entries()].map(([key, items]) => (
          <section key={key} style={{ marginTop: 16 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--color-text-muted)' }}>{key}</p>
            {items.map((s) => {
              const customer = customers.find((c) => c.id === s.customer_id);
              return (
                <div
                  key={s.id}
                  style={{
                    background: '#fff',
                    border: '1px solid var(--color-border)',
                    borderRadius: 10,
                    padding: 12,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{s.title}</strong>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                      {new Date(s.start_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                      {' - '}
                      {new Date(s.end_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {customer && <p style={{ margin: '4px 0 0', fontSize: 13 }}>顧客: {customer.name}</p>}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={() => setEditing(s)} style={{ flex: 1, padding: 8, fontSize: 13 }}>
                      編集
                    </button>
                    <button
                      onClick={() => onDelete(s.id)}
                      style={{ flex: 1, padding: 8, fontSize: 13, background: '#fff', border: '1px solid var(--color-border)', color: '#c0392b' }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}

      {editing && profile && (
        <ScheduleForm
          initial={editing === 'new' ? null : editing}
          customers={customers}
          profile={profile}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {confirmDialog}
    </main>
  );
}

function ScheduleForm({
  initial,
  customers,
  profile,
  onClose,
  onSaved,
}: {
  initial: Schedule | null;
  customers: Customer[];
  profile: Pick<Profile, 'id' | 'org_id'>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const now = new Date();
  const inHourLater = new Date(now.getTime() + 60 * 60 * 1000);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startAt, setStartAt] = useState(initial ? toDatetimeLocal(initial.start_at) : toDatetimeLocal(now.toISOString()));
  const [endAt, setEndAt] = useState(initial ? toDatetimeLocal(initial.end_at) : toDatetimeLocal(inHourLater.toISOString()));
  const [customerId, setCustomerId] = useState(initial?.customer_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: ScheduleInput = {
      title: title.trim(),
      customerId: customerId || null,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
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
          タイトル
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
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
          顧客（任意）
          <select
            value={customerId ?? ''}
            onChange={(e) => setCustomerId(e.target.value)}
            style={{ width: '100%', padding: 10, marginTop: 4 }}
          >
            <option value="">指定しない</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p style={{ color: '#c0392b', margin: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: 12, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            キャンセル
          </button>
          <button type="submit" disabled={saving} style={{ flex: 1, padding: 12 }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
