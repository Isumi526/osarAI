// PC 幅かどうか（2026-09-27・レスポンシブ対応）。これ以上の幅では下部ナビを左のサイドバーに替え、
// 一覧系の画面を広げる。CSS 側（styles.css の @media）と同じ閾値を使うこと。
import { useEffect, useState } from 'react';

export const DESKTOP_MIN_WIDTH = 960;
const QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

export function useIsDesktop(): boolean {
  const [is, setIs] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setIs(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return is;
}
