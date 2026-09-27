// 画面ヘッダーの共通ラッパー。.screen-header(position:fixed)の実高さを測って
// CSS変数 --header-height に反映し、.screen側のpadding-topとズレないようにする。
// 過去にposition:stickyで固定表示を試みたが、複数画面で直後のコンテンツ(最初のチャット
// バブル・タブ行等)と被る不具合が繰り返し発生し撤去した経緯がある(実高さをハードコードで
// 決め打ちしていたことが一因)。実測して都度反映することで同じ不具合の再発を避ける。
import { useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * 画面ヘッダー（2026-09-27 統一）。全画面「左寄せのタイトル＋右に操作」の形にそろえる。
 * - back: 下の階層の画面だけに付ける「‹」。タブで行き来できる画面には付けない
 *   （home: true の戻るは、サイドバーにホームがある PC では出さない）
 * - actions: 右側の操作（予定の月/週/日、通知ベルなど）
 * children を渡す旧来の使い方も残す（中身をそのまま並べる）。
 */
export function ScreenHeader({
  children,
  title,
  back,
  actions,
}: {
  children?: ReactNode;
  title?: ReactNode;
  back?: { to?: string; onClick?: () => void; label: string; home?: boolean };
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

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

  if (title === undefined) {
    return (
      <header className="screen-header" ref={ref}>
        {children}
      </header>
    );
  }

  return (
    <header className="screen-header" ref={ref}>
      <div className="screen-header__main">
        {back && (
          <button
            type="button"
            className={`screen-header__back${back.home ? ' is-home' : ''}`}
            aria-label={back.label}
            onClick={() => (back.onClick ? back.onClick() : navigate(back.to ?? '/'))}
          >
            ‹
          </button>
        )}
        <h1 className="screen-header__title">{title}</h1>
      </div>
      {actions && <div className="screen-header__actions">{actions}</div>}
    </header>
  );
}
