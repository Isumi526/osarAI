// 保存前の確認カード（共有）。AIの抽出をそのまま保存せず、必ずユーザーが目で見て直せるようにする。
// 統合AIチャット(AssistantChat) と 会議録音(Meeting) の両方で使う（2026-08-25 会議録音T1で切り出し）。
import { type Proposals } from '../lib/assistant.js';
import { AutoResizeTextarea } from './AutoResizeTextarea.js';

const toLines = (v: string[]) => v.join('\n');
const fromLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);
// datetime-local / date 入力とISO文字列の相互変換
const toLocalInput = (iso: string, withTime: boolean) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}` : date;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function ReviewCard({
  proposals,
  setProposals,
  committing,
  onCommit,
  onBackToChat,
  backLabel = 'まだ話す',
  minutes,
}: {
  proposals: Proposals;
  setProposals: (p: Proposals) => void;
  committing: boolean;
  onCommit: () => void;
  onBackToChat: () => void;
  /** 戻るボタンの文言（既定「まだ話す」）。会議録音では「録り直す」等に差し替える。 */
  backLabel?: string;
  /** 議事録（あれば冒頭に表示・T3）。 */
  minutes?: string | null;
}) {
  const empty =
    proposals.people.length === 0 &&
    proposals.schedules.length === 0 &&
    proposals.tasks.length === 0 &&
    proposals.self_notes.length === 0;

  return (
    <section
      style={{
        marginTop: 16,
        padding: 16,
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        display: 'grid',
        gap: 16,
      }}
    >
      {minutes && (
        <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--color-border)' }}>
          <strong style={{ fontSize: 13 }}>議事録</strong>
          <p style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--color-text)' }}>{minutes}</p>
        </div>
      )}

      <div>
        <strong>この内容で登録します</strong>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          間違いがあればここで直してください。保存するまで登録されません。
        </p>
      </div>

      {empty && <p style={{ color: 'var(--color-text-muted)' }}>登録する内容は見つかりませんでした。</p>}

      {proposals.people.map((p, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              つながり{p.customer_id ? '（登録済み）' : '（新規）'}
            </span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, people: proposals.people.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="このつながりを登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={p.name}
            onChange={(e) =>
              setProposals({
                ...proposals,
                people: proposals.people.map((x, j) =>
                  // 名前を手で直したら、サーバーが古い名前で出した類似候補は当てにならないので消す
                  j === i ? { ...x, name: e.target.value, similar: undefined } : x,
                ),
              })
            }
            placeholder="お名前"
            style={{ padding: 10, fontSize: 15 }}
          />
          {/* 表記揺れ（音声入力の「渡辺/渡邊」「タナカ/田中」等）で同じ人を二重登録しないための確認。
              勝手に寄せず、ユーザーに選ばせる。 */}
          {!p.customer_id && (p.similar?.length ?? 0) > 0 && (
            <div
              style={{
                padding: 10,
                borderRadius: 8,
                background: 'var(--color-surface-subtle, #fff7f0)',
                border: '1px solid var(--color-primary)',
                display: 'grid',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13 }}>
                似たお名前の方が登録済みです。同じ方なら選んでください（新しく作らずに追記します）。
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {p.similar!.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      setProposals({
                        ...proposals,
                        people: proposals.people.map((x, j) =>
                          // 既存に寄せる時は表記も既存側に合わせる（同じ人が2つの表記で残らないように）
                          j === i ? { ...x, customer_id: c.id, name: c.name, similar: undefined } : x,
                        ),
                      })
                    }
                    style={{
                      padding: '8px 12px',
                      fontSize: 13,
                      fontWeight: 700,
                      borderRadius: 999,
                      background: '#fff',
                      color: 'var(--color-primary)',
                      border: '1px solid var(--color-primary)',
                    }}
                  >
                    {c.name}さんと同じ
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setProposals({
                      ...proposals,
                      people: proposals.people.map((x, j) => (j === i ? { ...x, similar: undefined } : x)),
                    })
                  }
                  style={{
                    padding: '8px 12px',
                    fontSize: 13,
                    borderRadius: 999,
                    background: 'none',
                    color: 'var(--color-text-muted)',
                    border: '1px solid var(--color-border)',
                  }}
                >
                  別の人として登録
                </button>
              </div>
            </div>
          )}
          <LinesField
            label="要点"
            value={p.points}
            onChange={(v) =>
              setProposals({ ...proposals, people: proposals.people.map((x, j) => (j === i ? { ...x, points: v } : x)) })
            }
          />
          <LinesField
            label="ニーズ"
            value={p.needs}
            onChange={(v) =>
              setProposals({ ...proposals, people: proposals.people.map((x, j) => (j === i ? { ...x, needs: v } : x)) })
            }
          />
          <LinesField
            label="次アクション"
            value={p.next_actions}
            onChange={(v) =>
              setProposals({
                ...proposals,
                people: proposals.people.map((x, j) => (j === i ? { ...x, next_actions: v } : x)),
              })
            }
          />
        </div>
      ))}

      {proposals.schedules.map((s, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>予定</span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, schedules: proposals.schedules.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="この予定を登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={s.title}
            onChange={(e) =>
              setProposals({
                ...proposals,
                schedules: proposals.schedules.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
              })
            }
            placeholder="予定のタイトル"
            style={{ padding: 10, fontSize: 15 }}
          />
          <PersonSelect
            people={proposals.people}
            value={s.person_index}
            onChange={(v) =>
              setProposals({
                ...proposals,
                schedules: proposals.schedules.map((x, j) => (j === i ? { ...x, person_index: v } : x)),
              })
            }
          />
          <input
            type="datetime-local"
            value={toLocalInput(s.start_at, true)}
            onChange={(e) => {
              const start = fromLocalInput(e.target.value);
              if (!start) return;
              setProposals({
                ...proposals,
                schedules: proposals.schedules.map((x, j) =>
                  j === i ? { ...x, start_at: start, end_at: new Date(Date.parse(start) + 3600_000).toISOString() } : x,
                ),
              });
            }}
            style={{ padding: 10, fontSize: 14 }}
          />
        </div>
      ))}

      {proposals.tasks.map((t, i) => (
        <div key={i} style={{ display: 'grid', gap: 6, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>タスク</span>
            <button
              type="button"
              onClick={() => setProposals({ ...proposals, tasks: proposals.tasks.filter((_, j) => j !== i) })}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', padding: 4 }}
              aria-label="このタスクを登録しない"
            >
              ×
            </button>
          </div>
          <input
            value={t.title}
            onChange={(e) =>
              setProposals({
                ...proposals,
                tasks: proposals.tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
              })
            }
            placeholder="やること"
            style={{ padding: 10, fontSize: 15 }}
          />
          <PersonSelect
            people={proposals.people}
            value={t.person_index}
            onChange={(v) =>
              setProposals({
                ...proposals,
                tasks: proposals.tasks.map((x, j) => (j === i ? { ...x, person_index: v } : x)),
              })
            }
          />
          <input
            type="date"
            value={t.due_at ? toLocalInput(t.due_at, false) : ''}
            onChange={(e) =>
              setProposals({
                ...proposals,
                tasks: proposals.tasks.map((x, j) =>
                  j === i ? { ...x, due_at: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null } : x,
                ),
              })
            }
            style={{ padding: 10, fontSize: 14 }}
          />
        </div>
      ))}

      {proposals.self_notes.length > 0 && (
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
          <LinesField
            label="自分についての気づき"
            value={proposals.self_notes}
            onChange={(v) => setProposals({ ...proposals, self_notes: v })}
          />
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" onClick={onCommit} disabled={committing || empty}>
          {committing ? '保存中…' : 'この内容で保存'}
        </button>
        <button
          type="button"
          onClick={onBackToChat}
          style={{ background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {backLabel}
        </button>
      </div>
    </section>
  );
}

// 予定・タスクの「相手」。人物名はタイトルに埋めずリレーションで持つ（2026-08-06 指摘）。
function PersonSelect({
  people,
  value,
  onChange,
}: {
  people: { name: string }[];
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  if (people.length === 0) return null;
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
      相手
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        style={{ padding: 10, fontSize: 14 }}
      >
        <option value="">なし</option>
        {people.map((p, i) => (
          <option key={i} value={i}>
            {p.name}さん
          </option>
        ))}
      </select>
    </label>
  );
}

function LinesField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
      {label}（1行に1つ）
      <AutoResizeTextarea
        value={toLines(value)}
        onChange={(e) => onChange(fromLines(e.target.value))}
        rows={1}
        style={{ padding: 10, fontSize: 14, fontFamily: 'inherit', border: '1px solid var(--color-border)', borderRadius: 8, resize: 'none' }}
      />
    </label>
  );
}
