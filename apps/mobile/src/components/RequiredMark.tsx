// フォームの必須項目に付ける赤い※(議事録要望・(任意)表記の代わりに必須の方を明示する)。
export function RequiredMark() {
  return (
    <span aria-hidden="true" style={{ color: '#c0392b' }}>
      ※
    </span>
  );
}
