'use client';

// プラン選択画面(/subscribe)は課金導線に集中させたいため、共通ヘッダーナビを隠す
// (ダッシュボード等への導線があると未契約ユーザーが本題から逸れてしまうため)。
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const HIDE_ON = ['/subscribe'];

export function NavGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (HIDE_ON.includes(pathname)) return null;
  return <>{children}</>;
}
