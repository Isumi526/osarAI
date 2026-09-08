// 通知ベル（未読があれば赤いバッジ）。絵文字ではなくSVGで描く（アイコン統一の方針）。
export function BellIcon({ unread }: { unread: number }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <path
          d="M11 3a5 5 0 0 0-5 5v3.2L4.6 14a.6.6 0 0 0 .5.9h11.8a.6.6 0 0 0 .5-.9L16 11.2V8a5 5 0 0 0-5-5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M9 17.5a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span
          aria-label={`未読${unread}件`}
          style={{
            position: 'absolute',
            top: -2,
            right: -4,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            background: '#e0245e',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            textAlign: 'center',
          }}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </span>
  );
}
