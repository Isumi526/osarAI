// 録音の非公開Storageバケット共通ヘルパ（会議録音 T0）。
// 既存 /api/transcribe と同じ 'recordings' バケット・命名規則を共有する。
import type { createServiceRoleClient } from '@/lib/supabase/server';

export const RECORDINGS_BUCKET = 'recordings';

export async function ensureRecordingsBucket(admin: ReturnType<typeof createServiceRoleClient>): Promise<void> {
  const { data } = await admin.storage.getBucket(RECORDINGS_BUCKET);
  if (!data) {
    await admin.storage.createBucket(RECORDINGS_BUCKET, { public: false });
  }
}

export function extForMime(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}
