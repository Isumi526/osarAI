// 音声入力ボタンのアイコン（マイク / 停止）。絵文字の代わりに使う。
export function MicIcon({ recording }: { recording: boolean }) {
  if (recording) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" />
      <path
        d="M3 7.5a5 5 0 0 0 10 0M8 14.5v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
