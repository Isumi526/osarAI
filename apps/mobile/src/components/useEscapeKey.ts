// ダイアログ/モーダル表示中にEscキーで閉じられるようにする共通フック(議事録要望)。
import { useEffect, useRef } from 'react';

export function useEscapeKey(onClose: () => void, active = true): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);
}
