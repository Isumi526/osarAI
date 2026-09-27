// 録音の「初回だけ準備画面」判定（2026-09-27）。
// 一度でも録音を開始できた端末では、中央の録音ボタンを押した時点でそのまま録音を始める
// （使い方やマイクのテストは録音画面の「使い方・マイクの設定」から必要な時だけ開く）。
// 端末ごとの設定なので localStorage に持つ（PCでは共有ダイアログの選び方を一度覚えれば足りる）。
const KEY = 'osarai.meetingSetupDone';

export function isMeetingSetupDone(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
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
