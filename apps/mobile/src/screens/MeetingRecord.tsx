// 会議録音。相手にボットを見せず端末側で録音 → 文字起こし → 3データ抽出 → 自動保存（承認ステップは廃止）。
// - PC(T1): getDisplayMedia で画面全体/タブのシステム音声(相手)＋マイク(自分)を分離録音（透明）。
// - スマホ(T2): getDisplayMedia 非対応のためスピーカー再生＋マイクで室内録音（イヤホンは外す）。
// - T7/T7b: プラン確認／共有終了で自動解析／再試行／議事録の見たまま編集／人物メモ1本／端末別ガイド。
// - T7c（録音データの死守）: レコーダーはアプリ全体の MeetingSessionProvider に常駐し、録音チャンクは
//   IndexedDB に逐次保存。他画面へ移動しても録音は続き、タブを閉じても「ここまで」は残る。
//   次回 /meeting を開いた時に未処理の録音（録音中に離脱／未アップロード／解析済み未保存）を検出して続きから再開する。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import { ReviewCard, MinutesBlock, MinutesView } from '../components/ReviewCard.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';
import { useMeetingSession, fmtSec } from '../components/MeetingSession.js';
import { SILENCE_LEVEL, type RecordingResult } from '../hooks/useMeetingRecorder.js';
import { ApiError } from '../lib/api.js';
import { getEntitlement } from '../lib/subscription.js';
import {
  uploadMeetingAudio,
  ingestMeeting,
  commitMeeting,
  updateMeetingMinutes,
  listReviewingMeetings,
  type MeetingCommitResponse,
  getMeetingStatus,
  parseSpeakersClient,
  type IngestResponse,
  type MeetingCapture,
  type Speaker,
} from '../lib/meeting.js';
import { listCustomers, getMyProfile } from '../lib/db.js';
import { detectPlatform, BROWSER_LABEL, OS_LABEL } from '../lib/platform.js';
import {
  assembleBlob,
  deleteSession,
  listPendingSessions,
  purgeOldSessions,
  updateSession,
  type RecordingSession,
} from '../lib/recording-store.js';
import type { Proposals } from '../lib/assistant.js';

type Phase = 'idle' | 'processing' | 'failed' | 'reviewing' | 'saved' | 'committed';
type Gate = 'checking' | 'ok' | 'inactive' | 'plan';
type ReviewingRow = Awaited<ReturnType<typeof listReviewingMeetings>>[number];

const EMPTY: Proposals = { people: [], schedules: [], tasks: [], self_notes: [], self_fields: {} };
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '');

export function MeetingRecord() {
  const navigate = useNavigate();
  const ms = useMeetingSession();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const mode = ms.mode;
  const [platform] = useState(() => detectPlatform());
  const [gate, setGate] = useState<Gate>('checking');
  const [existing, setExisting] = useState<{ id: string; name: string }[]>([]);
  const [nameHint, setNameHint] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [processingSec, setProcessingSec] = useState(0);
  // 停止後の録音とアップロード済みパス。失敗しても捨てず、再試行に使う（1時間分を守る）。
  const [pending, setPending] = useState<RecordingResult | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposals>(EMPTY);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const [stillProcessing, setStillProcessing] = useState(false);
  const [primaryCustomerId, setPrimaryCustomerId] = useState<string | null>(null);
  // 自動保存の結果（承認ステップ廃止）
  const [saved, setSaved] = useState<MeetingCommitResponse | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [linkName, setLinkName] = useState('');
  const [linking, setLinking] = useState(false);
  const [minutesSaving, setMinutesSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  // 未保存の解析結果を後から保存している最中（復旧リスト）
  const [saving, setSaving] = useState(false);
  const minutesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 復旧候補（IndexedDB の未処理録音／サーバーの未保存の解析結果）
  const [recoverable, setRecoverable] = useState<RecordingSession[]>([]);
  const [reviewingRows, setReviewingRows] = useState<ReviewingRow[]>([]);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const isRecording = ms.starting || ms.recording;
  // 録音中は他画面へ移動しても録音が続く（Provider 常駐）ので下部ナビは止めない。
  // 解析中〜保存前は画面の state に結果があるので、移動には確認を挟む（IndexedDB/サーバーから復旧はできる）。
  const busy = phase === 'processing' || phase === 'failed' || phase === 'reviewing';
  useRegisterNavGuard(busy);
  useEffect(() => {
    if (!busy && !isRecording) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy, isRecording]);

  const loadRecoverables = useCallback(async () => {
    try {
      await purgeOldSessions();
      const pend = await listPendingSessions();
      setRecoverable(pend.filter((s) => !(ms.recording && ms.session?.id === s.id)));
    } catch {
      setRecoverable([]);
    }
    try {
      setReviewingRows(await listReviewingMeetings());
    } catch {
      setReviewingRows([]);
    }
  }, [ms.recording, ms.session?.id]);

  // 初期化: プラン確認・既存つながり・表示名ヒント・復旧候補
  useEffect(() => {
    let cancelled = false;
    listCustomers({ status: 'active' })
      .then((rows) => {
        if (!cancelled) setExisting(rows.map((c) => ({ id: c.id, name: c.name })));
      })
      .catch(() => {});
    getMyProfile()
      .then((p) => {
        if (cancelled) return;
        const name = (p?.display_name ?? '').trim();
        setNameHint(!name || /^[\w.+-]+$/.test(name) || name.length < 2);
      })
      .catch(() => {});
    getEntitlement()
      .then((ent) => {
        if (cancelled) return;
        if (!ent.active) setGate('inactive');
        else if (!ent.def || !ent.def.recordingImport) setGate('plan');
        else setGate('ok');
      })
      .catch(() => {
        if (!cancelled) setGate('ok');
      });
    void loadRecoverables();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wake Lock（画面消灯で録音が止まるのを防ぐ。iOSの背景化は防げない）＋タブタイトル
  useEffect(() => {
    if (!ms.recording) return;
    const originalTitle = document.title;
    const requestWakeLock = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') wakeLockRef.current = await wl.request('screen');
      } catch {
        /* 非対応は無視 */
      }
    };
    void requestWakeLock();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.title = originalTitle;
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [ms.recording]);
  useEffect(() => {
    if (ms.recording) document.title = `${ms.paused ? '❚❚ 一時停止' : '● 録音中'} ${fmtSec(ms.elapsed)} | osarAI`;
  }, [ms.recording, ms.paused, ms.elapsed]);
  useEffect(() => {
    if (phase !== 'processing') return undefined;
    setProcessingSec(0);
    const t = setInterval(() => setProcessingSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // 相手側の音声を一度でも検知したか（PC）
  const [otherDetected, setOtherDetected] = useState(false);
  useEffect(() => {
    if (!ms.recording) setOtherDetected(false);
    else if (ms.levels.other > SILENCE_LEVEL) setOtherDetected(true);
  }, [ms.recording, ms.levels.other]);

  async function onStart() {
    setError(null);
    setPhase('idle');
    const r = await ms.start();
    if (!r.ok) setError(r.error);
  }

  const applyIngest = useCallback((res: IngestResponse, sid: string | null) => {
    setMeetingId(res.meetingId);
    setProposals(res.proposals ? { ...res.proposals, self_notes: [], self_fields: {} } : EMPTY);
    setMinutes(res.minutes ?? '');
    setTranscript(res.transcript ?? '');
    setWarnings(res.warnings ?? []);
    setSpeakers(res.speakers ?? []);
    const initNames: Record<string, string> = {};
    for (const s of res.speakers ?? []) initNames[s.label] = s.isSelf ? '自分' : '';
    setSpeakerNames(initNames);
    if (res.committed) {
      // 自動保存済み: 承認は不要。結果を見せて、直したければその場で直す
      setSaved(res.committed);
      setPrimaryCustomerId(res.committed.customers[0]?.id ?? null);
      setPhase('saved');
      if (sid) void deleteSession(sid).catch(() => {});
      ms.clearSession();
    } else {
      // 自動保存に失敗した時だけ、従来の確認カードで手動保存
      setPhase('reviewing');
      if (sid) void updateSession(sid, { status: 'ingested', meetingId: res.meetingId }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 議事録の編集を自動保存（1秒デバウンス） */
  function onMinutesEdit(v: string) {
    setMinutes(v);
    if (!meetingId) return;
    setMinutesSaving('saving');
    if (minutesTimer.current) clearTimeout(minutesTimer.current);
    minutesTimer.current = setTimeout(async () => {
      try {
        await updateMeetingMinutes(meetingId, v);
        setMinutesSaving('saved');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMinutesSaving('idle');
      }
    }, 1000);
  }

  /** 相手を特定できなかった録音に、後から相手を紐付ける（既存 or 新規） */
  async function onLinkPerson() {
    const nm = linkName.trim();
    if (!meetingId || !nm) return;
    setLinking(true);
    setError(null);
    try {
      const known = existing.find((c) => normalize(c.name) === normalize(nm));
      const res = await commitMeeting({
        meetingId,
        proposals: { ...EMPTY, people: [{ customer_id: known?.id ?? null, name: known?.name ?? nm, points: [], needs: [], next_actions: [], custom_fields: {} }] },
        minutes,
        speakerNames: {},
      });
      setSaved(res);
      setPrimaryCustomerId(res.customers[0]?.id ?? null);
      setLinkName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLinking(false);
    }
  }

  /** アップロード（必要なら）→ 解析。失敗しても pending / uploadedPath は残す。 */
  const analyze = useCallback(
    async (rec: RecordingResult, knownPath: string | null, sid: string | null, capture: MeetingCapture) => {
      setPhase('processing');
      setError(null);
      setStillProcessing(false);
      try {
        let path = knownPath;
        if (!path) {
          path = await uploadMeetingAudio(rec.blob, rec.mimeType);
          setUploadedPath(path);
          if (sid) await updateSession(sid, { status: 'uploaded', uploadedPath: path }).catch(() => {});
        }
        const res = await ingestMeeting({
          recordingPath: path,
          mimeType: rec.mimeType,
          capture,
          durationSec: rec.durationSec,
          selfSegments: rec.selfSegments,
        });
        applyIngest(res, sid);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStillProcessing(e instanceof ApiError && e.code === 'still_processing');
        setError(msg);
        setPhase('failed');
      }
    },
    [applyIngest],
  );

  const onStop = useCallback(async () => {
    if (!ms.shareEnded) {
      const ok = await confirm('収録を終了して解析に進みますか？（終了後は録音を再開できません）');
      if (!ok) return;
    }
    const capture: MeetingCapture = mode === 'pc' ? 'pc_local' : 'mobile_speaker';
    const rec = await ms.stop();
    if (!rec) {
      setError('録音を取得できませんでした。もう一度お試しください。');
      return;
    }
    setPending(rec);
    setSessionId(rec.sessionId);
    setUploadedPath(null);
    await analyze(rec, null, rec.sessionId, capture);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms.shareEnded, ms.stop, mode, analyze]);

  // 共有元（Zoom画面/タブ）が閉じられた＝録音は確定済みで、できる操作は「解析」だけなので自動で進む。
  const shareEndedHandled = useRef(false);
  useEffect(() => {
    if (!ms.recording) {
      shareEndedHandled.current = false;
      return;
    }
    if (ms.shareEnded && !shareEndedHandled.current) {
      shareEndedHandled.current = true;
      void onStop();
    }
  }, [ms.recording, ms.shareEnded, onStop]);

  function onRetry() {
    if (!pending) return;
    void analyze(pending, uploadedPath, sessionId, mode === 'pc' ? 'pc_local' : 'mobile_speaker');
  }

  /**
   * サーバーに残っている未保存の録音（status=reviewing）を保存する。
   * 承認ステップは廃止したので、解析済みの候補をそのまま登録して「保存しました」画面に進む。
   * 保存に失敗した時だけ、従来の確認カードにフォールバックする。
   */
  const saveFromRow = useCallback(
    async (row: ReviewingRow, sid: string | null) => {
      const transcript = row.transcript ?? '';
      const p = row.proposals ? { ...row.proposals, self_notes: [], self_fields: {} } : EMPTY;
      setError(null);
      setMeetingId(row.id);
      setProposals(p);
      setMinutes(row.minutes ?? '');
      setTranscript(transcript);
      setWarnings([]);
      setSpeakers(parseSpeakersClient(transcript));
      setSpeakerNames({});
      setSaving(true);
      try {
        const res = await commitMeeting({ meetingId: row.id, proposals: p, minutes: row.minutes ?? '', speakerNames: {} });
        setSaved(res);
        setPrimaryCustomerId(res.customers[0]?.id ?? null);
        setPhase('saved');
        if (sid) void deleteSession(sid).catch(() => {});
        ms.clearSession();
      } catch {
        // 名前が無い等で保存できない場合は、確認カードで手当てしてもらう
        applyIngest(
          { meetingId: row.id, transcript, minutes: row.minutes, proposals: row.proposals, speakers: parseSpeakersClient(transcript), warnings: [] },
          sid,
        );
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyIngest],
  );

  /** 未処理の録音（IndexedDB）を続きから処理する。 */
  async function onRecover(s: RecordingSession) {
    setError(null);
    setSessionId(s.id);
    try {
      if (s.status === 'ingested' && s.meetingId) {
        const st = await getMeetingStatus(s.meetingId);
        if (st === 'reviewing') {
          const row = (await listReviewingMeetings()).find((r) => r.id === s.meetingId);
          if (row) {
            await saveFromRow(row, s.id);
            return;
          }
        }
        if (st === 'done') {
          await deleteSession(s.id);
          await loadRecoverables();
          return;
        }
      }
      const blob = await assembleBlob(s.id, s.mimeType);
      if (!blob && !s.uploadedPath) {
        setError('録音データが見つかりませんでした（保存前に閉じられた可能性があります）。');
        await deleteSession(s.id);
        await loadRecoverables();
        return;
      }
      const rec: RecordingResult = {
        blob: blob ?? new Blob([], { type: s.mimeType }),
        mimeType: s.mimeType,
        durationSec: s.durationSec ?? Math.round((s.updatedAt - s.startedAt) / 1000),
      };
      setPending(rec);
      setUploadedPath(s.uploadedPath ?? null);
      await analyze(rec, s.uploadedPath ?? null, s.id, s.capture);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDiscard(s: RecordingSession) {
    const ok = await confirm(`この録音（${fmtSec(s.durationSec ?? Math.round((s.updatedAt - s.startedAt) / 1000))}）を破棄しますか？`);
    if (!ok) return;
    await deleteSession(s.id).catch(() => {});
    await loadRecoverables();
  }

  /** 話者に入れた実名を候補（つながり）へ反映。既存のつながりなら customer_id 付きに。 */
  function syncSpeakerToPeople(name: string) {
    const nm = name.trim();
    if (!nm || nm === '自分') return;
    const known = existing.find((c) => normalize(c.name) === normalize(nm));
    const idx = proposals.people.findIndex((p) => (known && p.customer_id === known.id) || normalize(p.name) === normalize(nm));
    const unnamedIdx = idx >= 0 ? -1 : proposals.people.findIndex((p) => !p.customer_id && !p.name.trim());
    if (unnamedIdx >= 0) {
      setProposals({
        ...proposals,
        people: proposals.people.map((p, i) => (i === unnamedIdx ? { ...p, customer_id: known?.id ?? null, name: known?.name ?? nm, similar: undefined } : p)),
      });
      return;
    }
    if (idx >= 0) {
      if (known && !proposals.people[idx]!.customer_id) {
        setProposals({
          ...proposals,
          people: proposals.people.map((p, i) => (i === idx ? { ...p, customer_id: known.id, name: known.name, similar: undefined } : p)),
        });
      }
      return;
    }
    setProposals({
      ...proposals,
      people: [...proposals.people, { customer_id: known?.id ?? null, name: known?.name ?? nm, points: [], needs: [], next_actions: [], custom_fields: {} }],
    });
  }

  async function onCommit() {
    if (!meetingId || committing) return;
    const named = proposals.people.filter((p) => p.customer_id || p.name.trim());
    if (named.length === 0) {
      setError('話した相手を1人以上追加してください（議事録はその方の履歴に残ります）。');
      return;
    }
    if (proposals.people.some((p) => !p.customer_id && !p.name.trim())) {
      setError('お名前が未入力のつながりがあります。入力するか × で外してください。');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      let finalProposals = proposals;
      if (proposals.people.length === 1) {
        finalProposals = {
          ...proposals,
          schedules: proposals.schedules.map((s) => ({ ...s, person_index: s.person_index ?? 0 })),
          tasks: proposals.tasks.map((t) => ({ ...t, person_index: t.person_index ?? 0 })),
        };
      }
      const res = await commitMeeting({ meetingId, proposals: finalProposals, minutes, speakerNames });
      setPrimaryCustomerId(res.customers[0]?.id ?? null);
      setPhase('committed');
      if (sessionId) await deleteSession(sessionId).catch(() => {});
      ms.clearSession();
      void loadRecoverables();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  function resetToIdle() {
    setPhase('idle');
    setProposals(EMPTY);
    setMinutes(null);
    setWarnings([]);
    setMeetingId(null);
    setSpeakers([]);
    setSpeakerNames({});
    setPending(null);
    setUploadedPath(null);
    setSessionId(null);
    setError(null);
    void loadRecoverables();
  }

  async function onBackHome() {
    if (busy) {
      const ok = await confirm('まだ保存されていません。ホームに戻りますか？（解析結果は「前回の続き」から再開できます）');
      if (!ok) return;
    }
    navigate('/');
  }

  const showIdle = phase === 'idle' && !isRecording;

  return (
    <main className="screen" style={{ paddingBottom: BOTTOM_NAV_HEIGHT + 24 }}>
      <ScreenHeader>
        <button type="button" onClick={onBackHome} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary)' }}>
          ← ホーム
        </button>
        <strong>会議を録音する</strong>
        <span style={{ width: 48 }} />
      </ScreenHeader>
      <div style={{ display: 'grid', gap: 16 }}>
        {error && <p style={{ color: 'var(--color-danger, #c0392b)', fontSize: 14, margin: 0, whiteSpace: 'pre-wrap' }}>{error}</p>}

        {showIdle && gate === 'checking' && <p style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>確認中…</p>}
        {showIdle && gate === 'inactive' && (
          <Card title="会議録音はご契約中のアカウントでご利用いただけます">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>ご契約状況は Web のマイページからご確認ください。</p>
          </Card>
        )}
        {showIdle && gate === 'plan' && (
          <Card title="現在のプランでは会議録音をご利用いただけません">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>ご契約プランは Web のマイページからご確認ください。</p>
          </Card>
        )}

        {/* 復旧: 未処理の録音（端末に残っている）／未保存の解析結果（サーバー） */}
        {showIdle && gate === 'ok' && (recoverable.length > 0 || reviewingRows.length > 0) && (
          <section style={{ padding: 16, background: '#fff7f0', border: '1px solid var(--color-primary)', borderRadius: 12, display: 'grid', gap: 10 }}>
            <strong>前回の続きがあります</strong>
            {recoverable.map((s) => (
              <div key={s.id} style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
                <span style={{ fontSize: 13 }}>
                  {new Date(s.startedAt).toLocaleString('ja-JP')} の録音（{fmtSec(s.durationSec ?? Math.round((s.updatedAt - s.startedAt) / 1000))}・
                  {s.status === 'recording' ? '録音中に閉じられました' : s.status === 'stopped' ? '未アップロード' : s.status === 'uploaded' ? '解析前' : '解析済み・未保存'}）
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => void onRecover(s)} style={{ flex: 1, minHeight: 40 }}>
                    {s.status === 'ingested' ? '保存する' : '解析する'}
                  </button>
                  <button type="button" onClick={() => void onDiscard(s)} style={{ minHeight: 40, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                    破棄
                  </button>
                </div>
              </div>
            ))}
            {reviewingRows
              .filter((r) => !recoverable.some((s) => s.meetingId === r.id))
              .map((r) => (
                <div key={r.id} style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
                  <span style={{ fontSize: 13 }}>
                    {new Date(r.created_at).toLocaleString('ja-JP')} の会議（{r.duration_sec ? fmtSec(r.duration_sec) : '長さ不明'}・未保存）
                  </span>
                  <button type="button" onClick={() => void saveFromRow(r, null)} disabled={saving} style={{ minHeight: 40 }}>
                    {saving ? '保存中…' : '保存する'}
                  </button>
                </div>
              ))}
          </section>
        )}

        {showIdle && gate === 'ok' && mode === 'none' && (
          <Card title="この端末では会議録音を使えません">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>マイクの使えるブラウザ（パソコンの Chrome / Edge、またはスマホ）でお試しください。</p>
          </Card>
        )}

        {showIdle && gate === 'ok' && mode === 'pc' && (
          <>
            <Card title={`使い方（${OS_LABEL[platform.os]} の ${BROWSER_LABEL[platform.browser]}・Zoomアプリ）`}>
              <ol style={listStyle}>
                <li>Zoom を開いたまま「録音を開始」を押す</li>
                <li>
                  共有ダイアログで<b>「画面全体」</b>を選び、
                  {platform.os === 'windows' ? <b>「システム音声も共有する」にチェック</b> : <b>「システム音声を共有」が ON</b>}
                  になっていることを確認して「共有」
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    （OFF のままだと相手の声が録れません。その場合は開始できずにお知らせします。Zoom をブラウザで開いている場合は、そのタブを選び「タブの音声も共有」をON）
                  </span>
                </li>
                <li>会議が終わったら「収録を終了」。Zoom を先に閉じても自動で解析に進みます</li>
              </ol>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                相手にはボットも通知も一切表示されません。録音中は他の画面に移動しても録音は続き、タブを閉じてもそこまでの録音は端末に残ります。
                {platform.os === 'mac' && ' システム音声の共有は Chrome 141 以降・macOS 14.2 以降。初回は macOS の「画面収録」の許可が必要です。'}
              </p>
            </Card>
            {nameHint && <NameHint />}
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
          </>
        )}

        {showIdle && gate === 'ok' && mode === 'mic' && !platform.mobile && (
          <>
            <Card title={`${BROWSER_LABEL[platform.browser]} では相手の声を録音できません`}>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                Zoom の音声（相手の声）を取り込めるのは <b>Chrome または Edge</b> だけです。Chrome / Edge でこのページを開き直してください。
              </p>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(window.location.href)}
                style={{ marginTop: 10, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)', padding: '8px 12px', fontSize: 13 }}
              >
                このページのURLをコピー
              </button>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '12px 0 0' }}>
                どうしても {BROWSER_LABEL[platform.browser]} で行う場合は、Zoom をスピーカーで再生してマイクで室内録音できます（精度は落ちます）。
              </p>
            </Card>
            <button type="button" onClick={onStart} style={{ minHeight: 48, fontSize: 14, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              スピーカー再生＋マイクで録音する
            </button>
          </>
        )}

        {showIdle && gate === 'ok' && mode === 'mic' && platform.mobile && (
          <>
            <Card title={`使い方（${OS_LABEL[platform.os]}）`}>
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                スマホでは相手の声を直接取り込めないため、<b>イヤホンを外して端末のスピーカーで会議を再生</b>し、室内の音をマイクで録音します。
              </p>
              <ol style={listStyle}>
                <li>イヤホンを外し、Zoom / Meet を<b>スピーカー</b>にする</li>
                <li>「録音を開始」を押す（マイクの許可を求められたら許可）</li>
                <li>
                  <b>この画面を前面に表示したまま・画面ロックせずに</b>会議をする
                  <span style={{ display: 'block', fontSize: 12 }}>（他のアプリに切り替えたり画面を消すと、録音が止まることがあります。Zoom を別の端末で行うのが確実です）</span>
                </li>
                <li>会議が終わったら「収録を終了」</li>
              </ol>
            </Card>
            {nameHint && <NameHint />}
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
          </>
        )}

        {ms.starting && (
          <section style={{ display: 'grid', gap: 12, placeItems: 'center', padding: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16 }}>
              <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--color-border)', borderTopColor: 'var(--color-primary)', display: 'inline-block', animation: 'meeting-spin 0.8s linear infinite' }} />
              録音を準備しています…
            </div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
              {mode === 'pc' ? '共有ダイアログで画面を選ぶと、数秒で録音が始まります。' : 'マイクの許可を確認しています。'}
            </p>
            <style>{'@keyframes meeting-spin { to { transform: rotate(360deg); } }'}</style>
          </section>
        )}

        {ms.recording && phase === 'idle' && (
          <section style={{ display: 'grid', gap: 16, placeItems: 'center', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: ms.paused ? '#9a9183' : '#c0392b', display: 'inline-block' }} />
              {ms.paused ? '一時停止中' : '録音中'}
            </div>
            <div style={{ fontSize: 32, fontVariantNumeric: 'tabular-nums' }}>{fmtSec(ms.elapsed)}</div>
            <div style={{ width: '100%', display: 'grid', gap: 6 }}>
              {mode === 'pc' ? (
                <>
                  <LevelBar label="自分（マイク）" value={ms.levels.self} />
                  <LevelBar label="相手（Zoomの音声）" value={ms.levels.other} />
                </>
              ) : (
                <LevelBar label="マイク" value={ms.micLevel} />
              )}
            </div>
            {mode === 'pc' && (
              <p style={{ margin: 0, fontSize: 13, color: otherDetected ? 'var(--color-success, #2e8b57)' : 'var(--color-text-muted)', textAlign: 'center' }}>
                {otherDetected ? '相手の音声を検知しました。このまま会議を続けてください。' : '相手の音声はまだ検知していません（相手が話し始めると自動で反応します）。'}
              </p>
            )}
            {!ms.paused && mode === 'mic' && ms.micSilentSec >= 60 && (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                1分以上、音声を検知していません。会議が始まっているのに続く場合は、Zoom の音がスピーカーから出ているか・マイクがミュートでないかを確認してください。
              </p>
            )}
            <button
              type="button"
              onClick={() => (ms.paused ? ms.resume() : ms.pause())}
              style={{ minHeight: 48, fontSize: 15, width: '100%', background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              {ms.paused ? '録音を再開' : '一時停止（離席・別件の話題など）'}
            </button>
            <button type="button" onClick={() => void onStop()} style={{ minHeight: 52, fontSize: 16, width: '100%' }}>
              収録を終了して解析
            </button>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
              他の画面に移動しても録音は続きます。ここまでの録音は端末に自動保存されています。
            </p>
          </section>
        )}

        {phase === 'processing' && (
          <section style={{ display: 'grid', gap: 8, placeItems: 'center', padding: 32 }}>
            <div style={{ fontSize: 16 }}>{uploadedPath ? '文字起こし・解析中…' : 'アップロード中…'}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtSec(processingSec)}</div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center' }}>
              長い会議ほど時間がかかります（1時間の会議で1〜2分）。この画面を開いたままお待ちください。途中で閉じても、次に開いた時に続きから再開できます。
            </p>
          </section>
        )}

        {phase === 'failed' && (
          <section style={{ display: 'grid', gap: 12, padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
            <strong>{stillProcessing ? '解析がまだ終わっていません' : '解析に失敗しました'}</strong>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
              録音は{uploadedPath ? 'アップロード済みです。' : 'この端末に残っています。'}
              {stillProcessing ? '少し待ってから「再解析」を押すと、結果を取得できます。' : 'もう一度お試しください（再録音は不要です）。'}
            </p>
            <button type="button" onClick={onRetry} disabled={!pending} style={{ minHeight: 48 }}>
              {uploadedPath ? '再解析' : '再アップロードして解析'}
            </button>
          </section>
        )}

        {phase === 'reviewing' && (
          <>
            {warnings.length > 0 && (
              <section style={{ padding: 12, borderRadius: 10, background: '#fff7f0', border: '1px solid var(--color-primary)', fontSize: 13 }}>
                <strong>お知らせ</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                {pending && (
                  <button type="button" onClick={onRetry} style={{ marginTop: 8, padding: '4px 10px', fontSize: 13 }}>
                    再解析
                  </button>
                )}
              </section>
            )}
            {speakers.length > 0 && (
              <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, display: 'grid', gap: 8 }}>
                <div>
                  <strong>話者</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
                    誰の発言かを割り当てると、議事録や履歴が実名で残ります。
                    {mode !== 'pc' && ' 自分の発言には「自分」と入力してください。'}
                    {existing.length > 0 && ' 登録済みのつながりは入力欄から選べます（選ぶとその人の情報に重なります）。'}
                  </p>
                </div>
                {speakers.map((s) => (
                  <label key={s.label} style={{ display: 'grid', gridTemplateColumns: '72px 1fr', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{s.label}</span>
                    {s.isSelf ? (
                      <span style={{ fontSize: 14, padding: '8px 0' }}>自分</span>
                    ) : (
                      <input
                        list="meeting-people"
                        value={speakerNames[s.label] ?? ''}
                        onChange={(e) => setSpeakerNames((m) => ({ ...m, [s.label]: e.target.value }))}
                        onBlur={(e) => syncSpeakerToPeople(e.target.value)}
                        placeholder={mode === 'pc' ? 'お名前（相手）・登録済みなら選択' : 'お名前（自分なら「自分」）'}
                        style={{ padding: 8, fontSize: 14 }}
                      />
                    )}
                  </label>
                ))}
                <datalist id="meeting-people">
                  {existing.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                  {proposals.people
                    .filter((p) => p.name.trim() && !existing.some((c) => normalize(c.name) === normalize(p.name)))
                    .map((p, i) => (
                      <option key={`p${i}`} value={p.name} />
                    ))}
                </datalist>
              </section>
            )}
            <ReviewCard
              proposals={proposals}
              setProposals={setProposals}
              committing={committing}
              onCommit={onCommit}
              onBackToChat={async () => {
                const ok = await confirm('解析結果を破棄して最初に戻りますか？（録音は端末に残るので「前回の続き」から再開できます）');
                if (!ok) return;
                resetToIdle();
              }}
              backLabel="最初に戻る"
              minutes={minutes}
              onMinutesChange={setMinutes}
              allowAddPerson
            />
          </>
        )}

        {phase === 'saved' && saved && (
          <>
            <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, display: 'grid', gap: 10 }}>
              <strong>保存しました</strong>
              {saved.customers.length > 0 ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  {saved.customers.map((c) => (
                    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14 }}>
                      <span>
                        相手: <b>{c.name}</b>
                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{c.isNew ? '（新しく登録）' : '（登録済み）'}</span>
                      </span>
                      <button type="button" onClick={() => navigate(`/customers/${c.id}`)} style={{ padding: '6px 10px', fontSize: 13 }}>
                        カードを見る
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                    会話の中で相手の名前が分からなかったため、まだ誰の履歴にも紐付いていません。相手の名前を入れると、その人のカードに議事録が残ります。
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      list="meeting-people"
                      value={linkName}
                      onChange={(e) => setLinkName(e.target.value)}
                      placeholder="相手のお名前（登録済みなら選択）"
                      style={{ flex: 1, padding: 8, fontSize: 14 }}
                    />
                    <button type="button" onClick={() => void onLinkPerson()} disabled={linking || !linkName.trim()} style={{ padding: '8px 12px' }}>
                      {linking ? '…' : '紐付ける'}
                    </button>
                  </div>
                  <datalist id="meeting-people">
                    {existing.map((c) => (
                      <option key={c.id} value={c.name} />
                    ))}
                  </datalist>
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, fontSize: 13, color: 'var(--color-text-muted)' }}>
                <button type="button" onClick={() => navigate('/schedule')} style={{ background: 'none', border: 'none', padding: 0, color: saved.scheduleIds.length ? 'var(--color-primary)' : 'inherit' }}>
                  予定 {saved.scheduleIds.length}件
                </button>
                <button type="button" onClick={() => navigate('/tasks')} style={{ background: 'none', border: 'none', padding: 0, color: saved.taskIds.length ? 'var(--color-primary)' : 'inherit' }}>
                  タスク {saved.taskIds.length}件
                </button>
                {warnings.length > 0 && <span>（{warnings.join(' / ')}）</span>}
              </div>
            </section>
            <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
              <MinutesBlock minutes={minutes ?? ''} onChange={onMinutesEdit} />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
                {minutesSaving === 'saving' ? '保存中…' : minutesSaving === 'saved' ? '変更を保存しました' : '「編集」で直せます。変更は自動で保存されます。'}
              </div>
              {transcript && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--color-text-muted)' }}>全文（文字起こし）</summary>
                  <MinutesView text={transcript} />
                </details>
              )}
            </section>
            <button
              type="button"
              onClick={() => {
                resetToIdle();
                navigate('/');
              }}
              style={{ minHeight: 48, width: '100%', background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              ホームへ
            </button>
          </>
        )}

        {phase === 'committed' && (
          <section style={{ display: 'grid', gap: 12, placeItems: 'center', padding: 24 }}>
            <div style={{ fontSize: 18 }}>登録しました</div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
              議事録は相手のカードの履歴から、次回会う前にいつでも読み返せます。
            </p>
            {primaryCustomerId && (
              <button type="button" onClick={() => navigate(`/customers/${primaryCustomerId}`)} style={{ minHeight: 48, width: '100%' }}>
                相手のカードを見る
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{ minHeight: 48, width: '100%', background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              ホームへ
            </button>
          </section>
        )}
      </div>
      {confirmDialog}
    </main>
  );
}

const listStyle = { fontSize: 14, color: 'var(--color-text-muted)', margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 4 } as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
      <strong>{title}</strong>
      {children}
    </section>
  );
}

function NameHint() {
  return (
    <p style={{ margin: 0, padding: 12, borderRadius: 10, background: '#fff7f0', border: '1px solid var(--color-border)', fontSize: 13 }}>
      マイページの<b>表示名を本名（漢字）</b>にしておくと、会話の中の「自分」と「相手」の判定が安定し、議事録の精度が上がります。
    </p>
  );
}

function LevelBar({ label, value }: { label: string; value: number }) {
  const active = value > SILENCE_LEVEL;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
      <span>{label}</span>
      <div style={{ height: 10, borderRadius: 999, background: '#efeae0', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.round(Math.min(1, value) * 100)}%`,
            background: active ? 'var(--color-success, #2e8b57)' : '#c9c1b3',
            transition: 'width 120ms linear',
          }}
        />
      </div>
    </div>
  );
}
