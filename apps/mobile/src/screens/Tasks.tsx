// タスク一覧（2026-08-06 UI/UX刷新で下部ナビに追加）。
// AIチャットの発話から登録されたタスクと、この画面で手動追加したタスクの両方を扱う。
// 期限で「期限切れ / 今日 / 今後 / 期限なし」に区切り、やることが一目で分かる形にする。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listTasks, createTask, toggleTaskDone, deleteTask, type Task } from '../lib/tasks.js';
import { listCustomers, type Customer } from '../lib/db.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useConfirm } from '../components/ConfirmDialog.js';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDue(due: string): string {
  const d = new Date(due);
  const today = startOfToday();
  const diffDays = Math.round((+new Date(d.getFullYear(), d.getMonth(), d.getDate()) - +today) / 86400000);
  const date = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  if (diffDays === 0) return `今日 ${date}`;
  if (diffDays === 1) return `明日 ${date}`;
  if (diffDays < 0) return `${date}（${-diffDays}日超過）`;
  return date;
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newCustomerId, setNewCustomerId] = useState('');
  const [adding, setAdding] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const customerName = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (m.get(id) ?? null) : null);
  }, [customers]);

  async function reload() {
    setLoading(true);
    try {
      const rows = await listTasks();
      setTasks(rows);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    listCustomers({ status: 'active' })
      .then(setCustomers)
      .catch(() => undefined); // つながりが取れなくてもタスク一覧自体は使える
  }, []);

  async function onAdd() {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await createTask({
        title,
        dueAt: newDue ? new Date(newDue).toISOString() : null,
        customerId: newCustomerId || null,
      });
      setNewTitle('');
      setNewDue('');
      setNewCustomerId('');
      await reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setAdding(false);
    }
  }

  async function onToggle(t: Task) {
    // 楽観更新（チェックの反応を待たせない）。失敗したら読み直して整合を戻す。
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, status: x.status === 'done' ? 'open' : 'done' } : x)));
    try {
      await toggleTaskDone(t.id, t.status !== 'done');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      await reload();
    }
  }

  async function onDelete(t: Task) {
    const ok = await confirm(`「${t.title}」を削除しますか？`);
    if (!ok) return;
    try {
      await deleteTask(t.id);
      setTasks((ts) => ts.filter((x) => x.id !== t.id));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done');
  const today = startOfToday();
  const tomorrow = new Date(+today + 86400000);
  const groups: { label: string; danger?: boolean; items: Task[] }[] = [
    { label: '期限切れ', danger: true, items: open.filter((t) => t.due_at && new Date(t.due_at) < today) },
    {
      label: '今日',
      items: open.filter((t) => t.due_at && new Date(t.due_at) >= today && new Date(t.due_at) < tomorrow),
    },
    { label: '今後', items: open.filter((t) => t.due_at && new Date(t.due_at) >= tomorrow) },
    { label: '期限なし', items: open.filter((t) => !t.due_at) },
  ];

  return (
    <main className="screen">
      <ScreenHeader>
        <Link to="/">← ホーム</Link>
        <strong>タスク</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {/* 手動追加。AIチャットで話した内容からも自動で入る。 */}
      <div style={{ display: 'grid', gap: 8, margin: '12px 0 16px' }}>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onAdd();
          }}
          placeholder="やること（例: 〇〇さんに資料を送る）"
          style={{ padding: 12, fontSize: 15 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="date"
            value={newDue}
            onChange={(e) => setNewDue(e.target.value)}
            aria-label="期限"
            style={{ flex: 1, padding: 10, fontSize: 14 }}
          />
          <select
            value={newCustomerId}
            onChange={(e) => setNewCustomerId(e.target.value)}
            aria-label="関係するつながり"
            style={{ flex: 1, padding: 10, fontSize: 14 }}
          >
            <option value="">つながりなし</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}さん
              </option>
            ))}
          </select>
          <button type="button" onClick={onAdd} disabled={!newTitle.trim() || adding} style={{ padding: '0 18px' }}>
            追加
          </button>
        </div>
      </div>

      {loading ? (
        <p>読み込み中…</p>
      ) : open.length === 0 ? (
        <p style={{ color: '#6b6358' }}>
          未完了のタスクはありません。ホームの「AIと話す」で今日の出来事を話すと、やることも一緒に登録できます。
        </p>
      ) : (
        groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <section key={g.label} style={{ marginBottom: 16 }}>
              <h2
                style={{
                  fontSize: 13,
                  margin: '0 0 6px',
                  color: g.danger ? 'var(--color-danger)' : 'var(--color-text-muted)',
                }}
              >
                {g.label}（{g.items.length}）
              </h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {g.items.map((t) => (
                  <li key={t.id}>
                    <TaskRow task={t} name={customerName(t.customer_id)} onToggle={onToggle} onDelete={onDelete} />
                  </li>
                ))}
              </ul>
            </section>
          ))
      )}

      {done.length > 0 && (
        <section style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-text-muted)', fontSize: 13 }}
          >
            {showDone ? '完了したタスクを隠す' : `完了したタスク（${done.length}）を表示`}
          </button>
          {showDone && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
              {done.slice(0, 20).map((t) => (
                <li key={t.id}>
                  <TaskRow task={t} name={customerName(t.customer_id)} onToggle={onToggle} onDelete={onDelete} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {confirmDialog}
    </main>
  );
}

function TaskRow({
  task,
  name,
  onToggle,
  onDelete,
}: {
  task: Task;
  name: string | null;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
}) {
  const done = task.status === 'done';
  const overdue = !done && task.due_at && new Date(task.due_at) < startOfToday();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}
    >
      <input
        type="checkbox"
        checked={done}
        onChange={() => onToggle(task)}
        aria-label={done ? '未完了に戻す' : '完了にする'}
        style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, textDecoration: done ? 'line-through' : 'none', color: done ? 'var(--color-text-muted)' : 'inherit' }}>
          {task.title}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
          {task.due_at && <span style={{ color: overdue ? 'var(--color-danger)' : undefined }}>{fmtDue(task.due_at)}</span>}
          {name && <span>{name}さん</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDelete(task)}
        aria-label="削除"
        style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4, flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}
