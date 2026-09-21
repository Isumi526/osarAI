// 会議録音クライアント（T1）。録音Blobを Storage へ直接アップロード（署名付きURL）し、
// パスを /api/meeting/ingest に渡す（長尺base64をJSON bodyに載せない）。承認は既存 ReviewCard、
// 保存は /api/meeting/commit（サーバーで既存 commitProposals を再利用）。
import { apiPost } from './api.js';
import { supabase } from './supabase.js';
import type { Proposals } from './assistant.js';

const BUCKET = 'recordings';

export type MeetingCapture = 'pc_local' | 'mobile_speaker' | 'bot' | 'text_import';

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
  /** 議事録生成・候補抽出の部分失敗（文字起こしは成功）。UIで知らせて再解析を促す。 */
  warnings?: string[];
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
  /** 本人が話していた区間（PC録音のマイクゲートが記録・話者判定のヒント） */
  selfSegments?: [number, number][];
}): Promise<IngestResponse> {
  return apiPost<IngestResponse>('/api/meeting/ingest', input);
}

/** 文字起こしの行頭ラベルから話者ロスターを作る（サーバー lib/meeting-speakers と同じ規則の簡易版・復元用）。 */
export function parseSpeakersClient(transcript: string): Speaker[] {
  const known = new Map<string, boolean>();
  const generic = new Map<string, number>();
  for (const line of transcript.split('\n')) {
    const m = /^\s*(自分|相手\s*\d*|話者\s*[A-Za-z0-9]+)\s*[:：]/.exec(line);
    if (m) {
      const label = m[1]!.replace(/\s+/g, '');
      known.set(label, label === '自分');
      continue;
    }
    const g = /^\s*([^\s:：]{1,20}(?:[ \u3000][^\s:：]{1,20})?)\s*[:：]/.exec(line);
    if (g) generic.set(g[1]!.trim(), (generic.get(g[1]!.trim()) ?? 0) + 1);
  }
  const out: Speaker[] = [...known.entries()].map(([label, isSelf]) => ({ label, isSelf }));
  for (const [label, count] of generic) if (count >= 2 && out.length < 10 && !out.some((s) => s.label === label)) out.push({ label, isSelf: false });
  return out;
}

/** 承認待ち（status=reviewing）の録音を DB から読む（本人分のみ・RLS）。リロードや別端末からの再開用。 */
export async function listReviewingMeetings(): Promise<
  { id: string; created_at: string; duration_sec: number | null; transcript: string | null; minutes: string | null; proposals: Proposals | null }[]
> {
  const { data, error } = await supabase
    .from('meeting_recordings')
    .select('id, created_at, duration_sec, transcript, minutes, proposals, status')
    .eq('status', 'reviewing')
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    duration_sec: r.duration_sec,
    transcript: r.transcript,
    minutes: r.minutes,
    proposals: (r.proposals as unknown as Proposals | null) ?? null,
  }));
}

export async function getMeetingStatus(id: string): Promise<'processing' | 'reviewing' | 'done' | 'failed' | null> {
  const { data } = await supabase.from('meeting_recordings').select('status').eq('id', id).maybeSingle();
  return (data?.status as 'processing' | 'reviewing' | 'done' | 'failed' | undefined) ?? null;
}

/** 他ツール（Notta / Zoom 等）の文字起こしテキストを貼り付けて取り込む（録音なし・T7b）。 */
export async function ingestTranscriptText(transcriptText: string, recordedAt?: string): Promise<IngestResponse> {
  return apiPost<IngestResponse>('/api/meeting/ingest', { transcriptText, ...(recordedAt ? { recordedAt } : {}) });
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
