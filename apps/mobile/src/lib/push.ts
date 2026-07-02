// プッシュ通知の登録（§12・習慣化の中核）。
// ネイティブ(iOS/Android)のみ動作。Web/ブラウザプレビューでは no-op（PWAプッシュは使わない）。
// 起動/許可時にトークンを取得し push_tokens に保存 → サーバーがおさらい促しを送る。
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from './supabase.js';

let listenersBound = false;

export function isPushSupported(): boolean {
  return Capacitor.isNativePlatform();
}

async function saveToken(token: string) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  // unique(user_id, token) 前提で冪等 upsert
  await supabase
    .from('push_tokens')
    .upsert({ user_id: user.id, token, platform }, { onConflict: 'user_id,token' });
}

/**
 * 通知許可をリクエストしてトークン登録まで行う。
 * @returns 'granted' | 'denied' | 'unsupported'
 */
export async function enablePush(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';

  bindListeners();

  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return 'denied';

  await PushNotifications.register();
  return 'granted';
}

/** すでに許可済みなら黙って再登録（アプリ起動時用）。未許可なら何もしない。 */
export async function registerPushIfGranted(): Promise<void> {
  if (!isPushSupported()) return;
  const perm = await PushNotifications.checkPermissions();
  if (perm.receive !== 'granted') return;
  bindListeners();
  await PushNotifications.register();
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  PushNotifications.addListener('registration', (token) => {
    void saveToken(token.value);
  });
  PushNotifications.addListener('registrationError', (err) => {
    console.warn('[push] registration error', err);
  });
}
