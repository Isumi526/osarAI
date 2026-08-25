// 会議録音クライアント（T1）。録音Blobを Storage へ直接アップロード（署名付きURL）し、
// パスを /api/meeting/ingest に渡す（長尺base64をJSON bodyに載せない）。承認は既存 ReviewCard、
// 保存は /api/meeting/commit（サーバーで既存 commitProposals を再利用）。
import { apiPost } from './api.js';
import { supabase } from './supabase.js';
import type { Proposals } from './assistant.js';

const BUCKET = 'recordings';

export type MeetingCapture = 'pc_local' | 'mobile_speaker' | 'bot';

export interface Speaker {
  label: string;
  isSelf: boolean;
}

export interface IngestResponse {
  meetingId: string;
  transcript: string;
  minutes: string | null;
  proposals: Proposals | null;
  speakers: Speaker[];
  reused?: boolean;
}

export interface MeetingCommitResponse {
  meetingId: string;
  customers: { id: string; name: string; isNew: boolean }[];
  interactionIds: string[];
  scheduleIds: string[];
  taskIds: string[];
}

/** 録音Blobを Storage にアップロードし、保存先パスを返す。 */
export async function uploadMeetingAudio(blob: Blob, mimeType: string): Promise<string> {
  const { path, token } = await apiPost<{ path: string; token: string; signedUrl: string }>(
    '/api/meeting/upload-url',
    { mimeType },
  );
  const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, blob, { contentType: mimeType });
  if (error) throw new Error(`アップロードに失敗しました: ${error.message}`);
  return path;
}

/** アップロード済みパスから文字起こし→3データ抽出（承認前 proposals を返す）。 */
export async function ingestMeeting(input: {
  recordingPath: string;
  mimeType: string;
  capture: MeetingCapture;
  durationSec?: number;
  consentAck?: boolean;
}): Promise<IngestResponse> {
  return apiPost<IngestResponse>('/api/meeting/ingest', input);
}

/** 確認カードで編集した最終版を確定登録する（議事録も顧客の履歴に残す）。 */
export async function commitMeeting(input: {
  meetingId: string;
  proposals: Proposals;
  minutes?: string | null;
  /** 話者ラベル → 実名の割当（T4）。transcript/議事録のラベルを実名に置き換えて保存する。 */
  speakerNames?: Record<string, string>;
}): Promise<MeetingCommitResponse> {
  return apiPost<MeetingCommitResponse>('/api/meeting/commit', input);
}
