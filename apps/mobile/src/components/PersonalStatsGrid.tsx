// 個人の集計（今月/累計のアポ・おさらい・つながり・会議）。
// 2026-09-27: ホームを「次の行動」中心に作り替えたため、ホームからマイページへ移設（人判断）。
// 集計ブロックは読み込み前から表示しておき、読み込み中は数値を「-」にする
// （議事録要望: 非表示→いきなり表示だと鬱陶しいため）。
import { useEffect, useState } from 'react';
import { getPersonalStats, type PersonalStats } from '../lib/stats.js';

export function PersonalStatsGrid() {
  const [stats, setStats] = useState<PersonalStats | null>(null);
  useEffect(() => {
    getPersonalStats()
      .then(setStats)
      .catch(() => undefined); // 集計失敗は「-」表示に留め、画面全体は壊さない
  }, []);

  return (
    <section style={{ marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>あなたの活動</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
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
    </section>
  );
}
