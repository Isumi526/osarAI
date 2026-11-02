// 退会（アカウント削除・2026-09-28）。サーバーが契約の解約→録音音声→データ→ログイン情報の順に消す。
import { apiPost } from './api.js';

export async function deleteMyAccount(): Promise<void> {
  // 誤操作防止の合言葉（サーバーはこれが無いと消さない）
  await apiPost<{ ok: boolean }>('/api/account/delete', { confirm: 'DELETE_MY_ACCOUNT' });
}
