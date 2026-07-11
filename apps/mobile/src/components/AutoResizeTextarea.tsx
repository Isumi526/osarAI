// 入力内容に応じて高さが自動で広がるtextarea(議事録『review』要望)。
// 既存のtextareaと同じprops(value/onChange/onKeyDown等)をそのまま受け取れるよう
// React.TextareaHTMLAttributesをそのまま継承する(呼び出し側の書き換えを最小化)。
import { forwardRef, useEffect, useRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';

const MAX_HEIGHT_PX = 200; // 広がりすぎないよう上限を設ける(超えたらスクロール)

export const AutoResizeTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function AutoResizeTextarea(props, forwardedRef) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    function resize() {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    }

    useEffect(resize, [props.value]);

    return (
      <textarea
        {...props}
        ref={(el) => {
          innerRef.current = el;
          if (typeof forwardedRef === 'function') forwardedRef(el);
          else if (forwardedRef) forwardedRef.current = el;
        }}
        onInput={(e) => {
          resize();
          props.onInput?.(e);
        }}
        style={{ ...props.style, overflowY: 'hidden', maxHeight: MAX_HEIGHT_PX }}
      />
    );
  },
);
