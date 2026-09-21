// 端末/ブラウザ判定（会議録音のガイド出し分け用・T7b）。
// 録音方式の可否はブラウザ側の API 有無（useMeetingRecorder.supported 等）で決め、
// ここは「その環境で何をどう案内するか」の文言選択にだけ使う。
export type OS = 'mac' | 'windows' | 'ios' | 'android' | 'other';
export type Browser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'other';

export interface Platform {
  os: OS;
  browser: Browser;
  /** スマホ・タブレット（画面共有によるシステム音声取得が原理的に不可） */
  mobile: boolean;
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return { os: 'other', browser: 'other', mobile: false };
  const ua = navigator.userAgent || '';
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  const os: OS = /iPad|iPhone|iPod/.test(ua) || iPadOS
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : /Windows/.test(ua)
        ? 'windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'mac'
          : 'other';
  const uaData = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; mobile?: boolean } })
    .userAgentData;
  let browser: Browser = 'other';
  const brands = (uaData?.brands ?? []).map((b) => b.brand);
  if (brands.some((b) => /Microsoft Edge/i.test(b)) || /Edg\/|EdgiOS/.test(ua)) browser = 'edge';
  else if (brands.some((b) => /Google Chrome|Chromium/i.test(b)) || /Chrome\/|CriOS/.test(ua)) browser = 'chrome';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'firefox';
  else if (/Safari\//.test(ua)) browser = 'safari';
  const mobile = os === 'ios' || os === 'android' || uaData?.mobile === true || /Mobile/.test(ua);
  return { os, browser, mobile };
}

export const OS_LABEL: Record<OS, string> = {
  mac: 'Mac',
  windows: 'Windows',
  ios: 'iPhone / iPad',
  android: 'Android',
  other: 'この端末',
};
export const BROWSER_LABEL: Record<Browser, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  safari: 'Safari',
  firefox: 'Firefox',
  other: 'このブラウザ',
};
