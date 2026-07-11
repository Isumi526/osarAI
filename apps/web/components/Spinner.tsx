// フォーム送信中などの非同期処理を示す小さな回転スピナー。
export function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ animation: 'osarai-spin 0.8s linear infinite', verticalAlign: 'middle' }}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray="28 42"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}
