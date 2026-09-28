// 録音の「初回だけ準備画面」判定（2026-09-27）。
// 一度でも録音を開始できた端末では、中央の録音ボタンを押した時点でそのまま録音を始める
// （使い方やマイクのテストは録音画面の「使い方・マイクの設定」から必要な時だけ開く）。
// 端末ごとの設定なので localStorage に持つ（PCでは共有ダイアログの選び方を一度覚えれば足りる）。
const KEY = 'osarai.meetingSetupDone';
// 録音の同意（2026-09-28）。「相手の了承を得て録音する」「AI の記録は誤りや漏れがあり得るので自分でも確認する」
// に初回だけ同意してもらう。同意していない端末は、即録音にせず必ず準備画面を通す。
const CONSENT_KEY = 'osarai.recordingConsent';

export function hasRecordingConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function markRecordingConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* 保存できない環境では毎回確認するだけ */
  }
}

export function isMeetingSetupDone(): boolean {
  try {
    return localStorage.getItem(KEY) === '1' && hasRecordingConsent();
  } catch {
    return false;
  }
}

export function markMeetingSetupDone(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* 保存できなくても録音自体は使える（毎回準備画面が出るだけ） */
  }
}
