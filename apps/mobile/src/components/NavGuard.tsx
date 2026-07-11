// チャット系画面(おさらい/自分をおさらい/AI相談)で編集中(未送信の入力や未保存の
// セッション)に他画面へ移動しようとした際、下部固定ナビのタップでも確認ダイアログを
// 挟むための共有state。画面ごとのヘッダー「← 戻る」は各画面が個別にconfirm()して
// いるが、下部ナビは画面をまたぐ共通コンポーネントのため、画面側から
// useRegisterNavGuard(dirty) で「今、編集中か」を共有し、BottomNav側で参照する。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface NavGuardContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
}

const NavGuardContext = createContext<NavGuardContextValue | null>(null);

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const [isDirty, setDirty] = useState(false);
  return <NavGuardContext.Provider value={{ isDirty, setDirty }}>{children}</NavGuardContext.Provider>;
}

// 画面側: 現在「編集中」かどうかをレンダーの度に共有stateへ反映する。
// アンマウント時(画面遷移完了時)は必ずfalseに戻す。
export function useRegisterNavGuard(dirty: boolean) {
  const ctx = useContext(NavGuardContext);
  useEffect(() => {
    ctx?.setDirty(dirty);
  }, [ctx, dirty]);
  useEffect(() => () => ctx?.setDirty(false), [ctx]);
}

// BottomNav側: 現在いずれかの画面が編集中かどうか。
export function useNavGuardDirty(): boolean {
  return useContext(NavGuardContext)?.isDirty ?? false;
}
