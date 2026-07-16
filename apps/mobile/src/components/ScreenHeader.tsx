// 画面ヘッダーの共通ラッパー。.screen-header(position:fixed)の実高さを測って
// CSS変数 --header-height に反映し、.screen側のpadding-topとズレないようにする。
// 過去にposition:stickyで固定表示を試みたが、複数画面で直後のコンテンツ(最初のチャット
// バブル・タブ行等)と被る不具合が繰り返し発生し撤去した経緯がある(実高さをハードコードで
// 決め打ちしていたことが一因)。実測して都度反映することで同じ不具合の再発を避ける。
import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function ScreenHeader({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty('--header-height', `${el.offsetHeight}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className="screen-header" ref={ref}>
      {children}
    </header>
  );
}
