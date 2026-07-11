// おさらい完了画面のクラッカー(紙吹雪)演出(議事録『review』要望)。
// ライセンス懸念を避けるため外部素材は使わずCSSのみの自作アニメーション。
// マウント時に一度だけ再生し、アニメーション終了後は自動でDOMから消える(常時表示しない)。
import { useEffect, useState } from 'react';

const COLORS = ['#fd780f', '#ffb347', '#3a6ea5', '#e56800', '#7fb069'];
const PARTICLE_COUNT = 24;

interface Particle {
  id: number;
  left: number; // %
  delay: number; // s
  duration: number; // s
  color: string;
  rotate: number; // deg
}

function generateParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    delay: Math.random() * 0.3,
    duration: 1.1 + Math.random() * 0.6,
    color: COLORS[i % COLORS.length]!,
    rotate: Math.random() * 360,
  }));
}

export function ConfettiBurst() {
  const [particles] = useState(generateParticles);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', borderRadius: 16 }} aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          style={{
            position: 'absolute',
            top: -12,
            left: `${p.left}%`,
            width: 8,
            height: 8,
            background: p.color,
            borderRadius: 2,
            transform: `rotate(${p.rotate}deg)`,
            animation: `osarai-confetti-fall ${p.duration}s ease-in ${p.delay}s 1 both`,
          }}
        />
      ))}
      <style>{`
        @keyframes osarai-confetti-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(220px) rotate(540deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
