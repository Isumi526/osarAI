// 温度感(hot/warm/cold)を表す小さな色付きアイコン。絵文字の代わりに使う。
import type { Temperature } from '@osarai/shared';

const COLOR: Record<Temperature, string> = {
  hot: 'var(--color-danger)',
  warm: 'var(--color-primary)',
  cold: '#3a6ea5',
};

export function TempIcon({ value }: { value: Temperature }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: COLOR[value],
        marginRight: 4,
        verticalAlign: 'middle',
      }}
    />
  );
}
