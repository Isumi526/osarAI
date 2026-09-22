// 録音データの死守（T7c・2026-09-21）。
// 録音中のチャンク（MediaRecorder の timeslice ごとの Blob）を IndexedDB に逐次保存し、
// タブを閉じる・リロード・誤操作で離脱しても「ここまで録れた分」が端末に必ず残るようにする。
// 次にアプリを開いた時に未処理の録音を検出して、アップロード→解析→保存を続きから行う。
// 音声は端末内にだけ残る（サーバーへは従来どおりアップロード時に送る）。
const DB_NAME = 'osarai-recordings';
const DB_VERSION = 1;

export type RecordingStatus =
  | 'recording' // 録音中（または録音中に離脱した）
  | 'stopped' // 停止済み・未アップロード
  | 'uploaded' // Storage へアップロード済み・解析前
  | 'ingested' // 解析済み（meeting_recordings.status=reviewing）・未保存
  | 'done'; // 保存済み（削除待ち）

export interface RecordingSession {
  id: string;
  mode: 'pc' | 'mic';
  capture: 'pc_local' | 'mobile_speaker';
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  status: RecordingStatus;
  durationSec?: number;
  uploadedPath?: string;
  meetingId?: string;
  chunkCount: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        const st = db.createObjectStore('chunks', { keyPath: ['sessionId', 'index'] });
        st.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result: T | undefined;
        const r = fn(s);
        if (r) {
          r.onsuccess = () => {
            result = r.result;
          };
        }
        t.oncomplete = () => {
          db.close();
          resolve(result as T);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

export function isRecordingStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function createSession(meta: Omit<RecordingSession, 'updatedAt' | 'chunkCount' | 'status'>): Promise<RecordingSession> {
  const s: RecordingSession = { ...meta, status: 'recording', updatedAt: Date.now(), chunkCount: 0 };
  await tx('sessions', 'readwrite', (st) => st.put(s));
  return s;
}

export async function updateSession(id: string, patch: Partial<RecordingSession>): Promise<void> {
  const cur = await getSession(id);
  if (!cur) return;
  await tx('sessions', 'readwrite', (st) => st.put({ ...cur, ...patch, updatedAt: Date.now() }));
}

export async function getSession(id: string): Promise<RecordingSession | null> {
  const r = await tx<RecordingSession | undefined>('sessions', 'readonly', (st) => st.get(id));
  return r ?? null;
}

export async function listSessions(): Promise<RecordingSession[]> {
  const all = await tx<RecordingSession[]>('sessions', 'readonly', (st) => st.getAll());
  return (all ?? []).sort((a, b) => b.startedAt - a.startedAt);
}

/** 録音チャンクを追記。失敗しても録音自体は止めない（呼び出し側で握りつぶす）。 */
export async function appendChunk(sessionId: string, index: number, blob: Blob): Promise<void> {
  await tx('chunks', 'readwrite', (st) => st.put({ sessionId, index, blob }));
  // chunkCount/updatedAt は頻繁になるので sessions 側は 10 チャンクごとに更新
  if (index % 10 === 0) await updateSession(sessionId, { chunkCount: index + 1 });
}

/** 保存済みチャンクを順に結合して 1 つの Blob にする（MediaRecorder の timeslice 出力は連結で再生可能）。 */
export async function assembleBlob(sessionId: string, mimeType: string): Promise<Blob | null> {
  const rows = await tx<{ sessionId: string; index: number; blob: Blob }[]>('chunks', 'readonly', (st) =>
    st.index('bySession').getAll(sessionId),
  );
  if (!rows || rows.length === 0) return null;
  rows.sort((a, b) => a.index - b.index);
  const blob = new Blob(
    rows.map((r) => r.blob),
    { type: mimeType },
  );
  return blob.size > 0 ? blob : null;
}

export async function deleteSession(id: string): Promise<void> {
  await tx('sessions', 'readwrite', (st) => st.delete(id));
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('chunks', 'readwrite');
    const idx = t.objectStore('chunks').index('bySession');
    const req = idx.openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        t.objectStore('chunks').delete(cur.primaryKey);
        cur.continue();
      }
    };
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

/** 未処理（保存まで終わっていない）録音。復旧候補として画面に出す。 */
export async function listPendingSessions(): Promise<RecordingSession[]> {
  const all = await listSessions();
  return all.filter((s) => s.status !== 'done');
}

/** 古い完了済みセッションの掃除（保存済みは即削除するが、念のため 7 日超は掃く）。 */
export async function purgeOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const all = await listSessions();
  for (const s of all) {
    if (s.status === 'done' || Date.now() - s.updatedAt > maxAgeMs) await deleteSession(s.id);
  }
}
