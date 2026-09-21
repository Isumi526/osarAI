// 会議録音。相手にボットを見せず端末側で録音 → 文字起こし → 3データ抽出 → ReviewCard承認 → 登録。
// - PC(T1): getDisplayMedia で画面全体/タブのシステム音声(相手)＋マイク(自分)を分離録音（透明）。
// - スマホ(T2): getDisplayMedia 非対応のためスピーカー再生＋マイクで室内録音（イヤホンは外す）。
// - T7: 録音前のプラン確認／共有終了後も録音を失わない／失敗時の再試行（録音・アップロード済みパスを保持）／
//        離脱ガード／Wake Lock／議事録の編集／相手の手動追加／解析の部分失敗(warnings)の表示。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav.js';
import { ReviewCard } from '../components/ReviewCard.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { useRegisterNavGuard } from '../components/NavGuard.js';
import { useMeetingRecorder, type RecordingResult } from '../hooks/useMeetingRecorder.js';
import { useRecorder } from '../hooks/useRecorder.js';
import { ApiError } from '../lib/api.js';
import { getEntitlement } from '../lib/subscription.js';
import { uploadMeetingAudio, ingestMeeting, ingestTranscriptText, commitMeeting, type IngestResponse, type MeetingCapture, type Speaker } from '../lib/meeting.js';
import { listCustomers } from '../lib/db.js';
import { detectPlatform, BROWSER_LABEL, OS_LABEL } from '../lib/platform.js';
import { SILENCE_LEVEL } from '../hooks/useMeetingRecorder.js';
import type { Proposals } from '../lib/assistant.js';

type Phase = 'idle' | 'recording' | 'processing' | 'failed' | 'reviewing' | 'committed';
type Gate = 'checking' | 'ok' | 'inactive' | 'plan';

const EMPTY: Proposals = { people: [], schedules: [], tasks: [], self_notes: [], self_fields: {} };
// スマホの室内録音は相手の声がスピーカー経由で小さくなりがちなので、少し高めのビットレート
const MOBILE_BITRATE = 96_000;

const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').replace(/(さん|様|さま|氏|くん|ちゃん)$/u, '');

export function MeetingRecord() {
  const navigate = useNavigate();
  const pcRec = useMeetingRecorder();
  const micRec = useRecorder();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // PCでシステム音声を録れるなら透明モード。無理ならマイク（スピーカー再生の室内録音）にフォールバック。
  // 'mic' はスマホだけでなく、デスクトップの Safari/Firefox（システム音声共有が非対応）も含む。
  const mode: 'pc' | 'mic' | 'none' = pcRec.supported ? 'pc' : micRec.supported ? 'mic' : 'none';
  const [platform] = useState(() => detectPlatform());
  const [gate, setGate] = useState<Gate>('checking');
  // 話者割当・手動追加で既存のつながりを選べるようにする（名前で一致したら customer_id を紐付け）
  const [existing, setExisting] = useState<{ id: string; name: string }[]>([]);
  const [importText, setImportText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [processingSec, setProcessingSec] = useState(0);
  // 停止後の録音と、アップロード済みのパス。失敗しても捨てず、再試行に使う（1時間分を守る）。
  const [pending, setPending] = useState<RecordingResult | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposals>(EMPTY);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  // ingest が 409 still_processing（前回の解析がまだ走っている）を返した時は「失敗」ではなく待ち案内にする
  const [stillProcessing, setStillProcessing] = useState(false);
  const [primaryCustomerId, setPrimaryCustomerId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const paused = mode === 'pc' ? pcRec.paused : micRec.paused;
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const busy = phase === 'recording' || phase === 'processing' || phase === 'failed' || phase === 'reviewing';
  // 下部ナビ／ブラウザの戻る・リロードで録音や未保存の解析結果を失わない
  useRegisterNavGuard(busy);
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  // 録音前にプランを確認する（録音してからアップロード時に 403 で1時間分を失わないため）。
  // 価格・課金への導線はアプリ内に置かない（CLAUDE.md §11）。
  useEffect(() => {
    let cancelled = false;
    listCustomers({ status: 'active' })
      .then((rows) => {
        if (!cancelled) setExisting(rows.map((c) => ({ id: c.id, name: c.name })));
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
        if (!cancelled) setGate('ok'); // 判定に失敗してもサーバー側の砦がある。体験ゲートは開けておく
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 録音中の経過タイマー・タブタイトル・Wake Lock（画面消灯で録音が止まるのを防ぐ。iOSの背景化は防げない）
  useEffect(() => {
    if (phase === 'recording') {
      setElapsed(0);
      timerRef.current = setInterval(() => {
        if (!pausedRef.current) setElapsed((s) => s + 1);
      }, 1000);
      const originalTitle = document.title;
      const requestWakeLock = async () => {
        try {
          const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } })
            .wakeLock;
          if (wl && document.visibilityState === 'visible') wakeLockRef.current = await wl.request('screen');
        } catch {
          /* 非対応・拒否は無視 */
        }
      };
      void requestWakeLock();
      const onVisibility = () => {
        if (document.visibilityState === 'visible') void requestWakeLock();
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        document.removeEventListener('visibilitychange', onVisibility);
        document.title = originalTitle;
        void wakeLockRef.current?.release().catch(() => {});
        wakeLockRef.current = null;
      };
    }
    return undefined;
  }, [phase]);
  useEffect(() => {
    if (phase === 'recording') document.title = `${paused ? '❚❚ 一時停止' : '● 録音中'} ${fmt(elapsed)} | osarAI`;
  }, [phase, elapsed, paused]);
  useEffect(() => {
    if (phase !== 'processing') return undefined;
    setProcessingSec(0);
    const t = setInterval(() => setProcessingSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function onStart() {
    setError(null);
    if (mode === 'pc') {
      const r = await pcRec.start();
      if (!r.ok) {
        setError(r.error);
        return;
      }
    } else if (mode === 'mic') {
      const r = await micRec.start({ audioBitsPerSecond: MOBILE_BITRATE, meter: true });
      if (!r.ok) {
        setError(r.error);
        return;
      }
    } else {
      return;
    }
    setPending(null);
    setUploadedPath(null);
    setPhase('recording');
  }

  /** ingest の結果を承認画面の state に展開する（録音・テキスト取り込み共通）。 */
  function applyIngest(res: IngestResponse) {
    setMeetingId(res.meetingId);
    setProposals(res.proposals ?? EMPTY);
    setMinutes(res.minutes ?? '');
    setWarnings(res.warnings ?? []);
    setSpeakers(res.speakers ?? []);
    const initNames: Record<string, string> = {};
    for (const s of res.speakers ?? []) initNames[s.label] = s.isSelf ? '自分' : '';
    setSpeakerNames(initNames);
    setPhase('reviewing');
  }

  /** 他ツールの文字起こしを貼り付けて取り込む（録音なし・レビュー/検証にも使う）。 */
  async function onImportText() {
    const text = importText.trim();
    if (!text) return;
    setPhase('processing');
    setError(null);
    setPending(null);
    setUploadedPath(null);
    try {
      applyIngest(await ingestTranscriptText(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  /** 相手の音声が入っていない（共有の「システム音声」OFF 等）ので録音を破棄して最初から。 */
  async function onDiscardAndRestart() {
    const ok = await confirm('ここまでの録音を破棄して、録音の設定からやり直しますか？');
    if (!ok) return;
    if (mode === 'pc') await pcRec.stop();
    else await micRec.stop();
    setPhase('idle');
    setError(null);
  }

  /** アップロード（必要なら）→ 解析。失敗しても pending / uploadedPath は残す。 */
  const analyze = useCallback(
    async (rec: RecordingResult, knownPath: string | null) => {
      setPhase('processing');
      setError(null);
      setStillProcessing(false);
      try {
        const capture: MeetingCapture = mode === 'pc' ? 'pc_local' : 'mobile_speaker';
        let path = knownPath;
        if (!path) {
          path = await uploadMeetingAudio(rec.blob, rec.mimeType);
          setUploadedPath(path);
        }
        const res = await ingestMeeting({
          recordingPath: path,
          mimeType: rec.mimeType,
          capture,
          durationSec: rec.durationSec,
        });
        applyIngest(res);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStillProcessing(e instanceof ApiError && e.code === 'still_processing');
        setError(msg);
        setPhase('failed');
      }
    },
    [mode],
  );

  async function onStop() {
    if (!pcRec.shareEnded) {
      const ok = await confirm('収録を終了して解析に進みますか？（終了後は録音を再開できません）');
      if (!ok) return;
    }
    // モードごとに録音を止めて、共通の {blob, mimeType, durationSec} に正規化する。
    let rec: RecordingResult | null = null;
    if (mode === 'pc') {
      rec = await pcRec.stop();
    } else {
      const blob = await micRec.stop();
      if (blob) rec = { blob, mimeType: blob.type || 'audio/webm', durationSec: elapsed };
    }
    if (!rec) {
      setError('録音を取得できませんでした。もう一度お試しください。');
      setPhase('idle');
      return;
    }
    setPending(rec);
    await analyze(rec, null);
  }

  function onRetry() {
    if (!pending) return;
    void analyze(pending, uploadedPath);
  }

  /** 話者に入れた実名が候補（つながり）に無ければ、その相手を候補として足す（取りこぼし対策・T7）。 */
  function syncSpeakerToPeople(name: string) {
    const nm = name.trim();
    if (!nm || nm === '自分') return;
    // 既存のつながりと名前が一致すれば、その人（customer_id 付き）として候補に載せる＝情報が重なる
    const known = existing.find((c) => normalize(c.name) === normalize(nm));
    const idx = proposals.people.findIndex((p) => (known && p.customer_id === known.id) || normalize(p.name) === normalize(nm));
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
      people: [
        ...proposals.people,
        { customer_id: known?.id ?? null, name: known?.name ?? nm, points: [], needs: [], next_actions: [], custom_fields: {} },
      ],
    });
  }

  async function onCommit() {
    if (!meetingId || committing) return;
    const named = proposals.people.filter((p) => p.customer_id || p.name.trim());
    if (named.length === 0) {
      setError('話した相手を1人以上追加してください（議事録はその方の履歴に残ります）。');
      return;
    }
    const unnamed = proposals.people.find((p) => !p.customer_id && !p.name.trim());
    if (unnamed) {
      setError('お名前が未入力のつながりがあります。入力するか × で外してください。');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      // 1対1の会議で相手が1人に確定しているなら、相手未指定の予定/タスクはその人に紐付ける
      // （抽出時点では相手の名前が分からず person_index が null になりやすいため）。
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  }

  async function onBackHome() {
    if (busy) {
      const ok = await confirm(
        phase === 'recording'
          ? '録音中です。ホームに戻ると録音は破棄されます。よろしいですか？'
          : 'まだ保存されていません。ホームに戻ると解析結果は失われます。よろしいですか？',
      );
      if (!ok) return;
    }
    navigate('/');
  }

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
        {error && (
          <p style={{ color: 'var(--color-danger, #c0392b)', fontSize: 14, margin: 0, whiteSpace: 'pre-wrap' }}>{error}</p>
        )}

        {phase === 'idle' && gate === 'checking' && (
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)' }}>確認中…</p>
        )}

        {phase === 'idle' && gate === 'inactive' && (
          <Card title="会議録音はご契約中のアカウントでご利用いただけます">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
              ご契約状況は Web のマイページからご確認ください。
            </p>
          </Card>
        )}

        {phase === 'idle' && gate === 'plan' && (
          <Card title="現在のプランでは会議録音をご利用いただけません">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
              ご契約プランは Web のマイページからご確認ください。
            </p>
          </Card>
        )}

        {phase === 'idle' && gate === 'ok' && mode === 'none' && (
          <Card title="この端末では会議録音を使えません">
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginTop: 8 }}>
              マイクの使えるブラウザ（パソコンの Chrome / Edge、またはスマホ）でお試しください。
            </p>
          </Card>
        )}

        {phase === 'idle' && gate === 'ok' && mode === 'pc' && (
          <>
            <Card title={`使い方（${OS_LABEL[platform.os]} の ${BROWSER_LABEL[platform.browser]}・Zoomアプリ）`}>
              <ol style={listStyle}>
                <li>Zoom を開いたまま「録音を開始」を押す</li>
                <li>
                  共有ダイアログで<b>「画面全体」</b>を選ぶ
                </li>
                <li>
                  {platform.os === 'windows' ? (
                    <>
                      <b>「システム音声も共有する」にチェック</b>を入れてから「共有」
                    </>
                  ) : (
                    <>
                      左下の<b>「システム音声を共有」をON</b>にしてから「共有」
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--color-danger, #c0392b)' }}>
                        ※このスイッチは<b>はじめはOFF</b>になっています。OFF のままだと相手の声が録れません（開始直後に警告が出ます）
                      </span>
                    </>
                  )}
                  <span style={{ display: 'block', fontSize: 12 }}>
                    （Zoom をブラウザで開いている場合は、その<b>タブ</b>を選び「タブの音声も共有」をON）
                  </span>
                </li>
                <li>会議が終わったら「収録を終了」。Zoom を先に閉じても録音は残ります</li>
              </ol>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                相手にはボットも通知も一切表示されません。イヤホン推奨（スピーカーだと相手の声がマイクにも入り、話者の区別が付きにくくなります）。
                {platform.os === 'mac' && ' システム音声の共有は Chrome 141 以降・macOS 14.2 以降。初回は macOS の「画面収録」の許可が必要です。'}
              </p>
            </Card>
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
          </>
        )}

        {phase === 'idle' && gate === 'ok' && mode === 'mic' && !platform.mobile && (
          <>
            <Card title={`${BROWSER_LABEL[platform.browser]} では相手の声を録音できません`}>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                Zoom の音声（相手の声）を取り込めるのは <b>Chrome または Edge</b> だけです。
                Chrome / Edge でこのページを開き直してください。
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
            <button
              type="button"
              onClick={onStart}
              style={{ minHeight: 48, fontSize: 14, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              スピーカー再生＋マイクで録音する
            </button>
          </>
        )}

        {phase === 'idle' && gate === 'ok' && mode === 'mic' && platform.mobile && (
          <>
            <Card title={`使い方（${OS_LABEL[platform.os]}）`}>
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                スマホでは相手の声を直接取り込めないため、<b>イヤホンを外して端末のスピーカーで会議を再生</b>し、
                室内の音をマイクで録音します。
              </p>
              <ol style={listStyle}>
                <li>イヤホンを外し、Zoom / Meet を<b>スピーカー</b>にする</li>
                <li>「録音を開始」を押す（マイクの許可を求められたら許可）</li>
                <li>
                  <b>この画面を前面に表示したまま・画面ロックせずに</b>会議をする
                  <span style={{ display: 'block', fontSize: 12 }}>
                    （他のアプリに切り替えたり画面を消すと、録音が止まることがあります。Zoom を別の端末で行うのが確実です）
                  </span>
                </li>
                <li>会議が終わったら「収録を終了」</li>
              </ol>
            </Card>
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
          </>
        )}

        {phase === 'idle' && gate === 'ok' && mode !== 'none' && (
          <details style={{ padding: 12, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 14 }}>文字起こしテキストを貼り付けて取り込む（Notta / Zoom など）</summary>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0' }}>
              他のツールで文字起こし済みの会議を、そのまま議事録・予定・タスク・つながりに整理します。「話者名　00:01」の形式や「名前: 発言」の形式に対応。
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              placeholder="ここに文字起こしを貼り付け"
              style={{ width: '100%', boxSizing: 'border-box', padding: 10, fontSize: 13, fontFamily: 'inherit', border: '1px solid var(--color-border)', borderRadius: 8 }}
            />
            <button type="button" onClick={onImportText} disabled={!importText.trim()} style={{ marginTop: 8, minHeight: 44, width: '100%' }}>
              取り込んで解析
            </button>
          </details>
        )}

        {phase === 'recording' && (
          <section style={{ display: 'grid', gap: 16, placeItems: 'center', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: paused ? '#9a9183' : '#c0392b',
                  display: 'inline-block',
                }}
              />
              {pcRec.shareEnded ? '録音済み（共有が終了しました）' : paused ? '一時停止中' : '録音中'}
            </div>
            <div style={{ fontSize: 32, fontVariantNumeric: 'tabular-nums' }}>{fmt(elapsed)}</div>

            {/* 入力レベル：本当に音が入っているかを見せる（不安対策・設定ミスの早期検知） */}
            {!pcRec.shareEnded && (
              <div style={{ width: '100%', display: 'grid', gap: 6 }}>
                {mode === 'pc' ? (
                  <>
                    <LevelBar label="自分（マイク）" value={pcRec.levels.self} />
                    <LevelBar label="相手（Zoomの音声）" value={pcRec.levels.other} />
                  </>
                ) : (
                  <LevelBar label="マイク" value={micRec.level} />
                )}
              </div>
            )}
            {!paused && !pcRec.shareEnded && mode === 'pc' && pcRec.otherSilentSec >= 15 && (
              <div style={{ width: '100%', padding: 12, borderRadius: 10, background: '#fff7f0', border: '1px solid var(--color-danger, #c0392b)', fontSize: 13 }}>
                <strong>相手の音声が入っていません（{pcRec.otherSilentSec}秒）</strong>
                <p style={{ margin: '6px 0 8px' }}>
                  共有ダイアログで「システム音声を共有」が OFF のままだった可能性があります。相手が話している最中もこの表示なら、いったん録り直してください（共有をやり直す必要があります）。
                </p>
                <button type="button" onClick={onDiscardAndRestart} style={{ padding: '8px 12px', fontSize: 13 }}>
                  録音を破棄してやり直す
                </button>
              </div>
            )}
            {!paused && mode === 'mic' && micRec.silentSec >= 15 && (
              <div style={{ width: '100%', padding: 12, borderRadius: 10, background: '#fff7f0', border: '1px solid var(--color-danger, #c0392b)', fontSize: 13 }}>
                <strong>音声が入っていません（{micRec.silentSec}秒）</strong>
                <p style={{ margin: '6px 0 0' }}>Zoom の音がスピーカーから出ているか、マイクがミュートになっていないか確認してください。</p>
              </div>
            )}

            {pcRec.shareEnded && (
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
                画面共有が終了したため、ここまでの録音を保持しています。「収録を終了」で解析に進んでください。
              </p>
            )}
            {!pcRec.shareEnded && (
              <button
                type="button"
                onClick={() => (paused ? (mode === 'pc' ? pcRec.resume() : micRec.resume()) : mode === 'pc' ? pcRec.pause() : micRec.pause())}
                style={{ minHeight: 48, fontSize: 15, width: '100%', background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                {paused ? '録音を再開' : '一時停止（離席・別件の話題など）'}
              </button>
            )}
            <button type="button" onClick={onStop} style={{ minHeight: 52, fontSize: 16, width: '100%' }}>
              収録を終了して解析
            </button>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
              この画面を閉じたり別の画面に移動すると録音は失われます。
            </p>
          </section>
        )}

        {phase === 'processing' && (
          <section style={{ display: 'grid', gap: 8, placeItems: 'center', padding: 32 }}>
            <div style={{ fontSize: 16 }}>{uploadedPath ? '文字起こし・解析中…' : 'アップロード中…'}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(processingSec)}</div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center' }}>
              長い会議ほど時間がかかります（1時間の会議で数分かかることがあります）。この画面を開いたままお待ちください。
            </p>
          </section>
        )}

        {phase === 'failed' && (
          <section style={{ display: 'grid', gap: 12, padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12 }}>
            <strong>{stillProcessing ? '解析がまだ終わっていません' : '解析に失敗しました'}</strong>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
              録音は{uploadedPath ? 'アップロード済みです。' : 'この画面に残っています。'}
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
                <strong>一部の解析に失敗しました</strong>
                <ul style={{ margin: '6px 0 8px', paddingLeft: 18 }}>
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                文字起こしは完了しています。内容を手で補うか、
                <button type="button" onClick={onRetry} disabled={!pending} style={{ marginLeft: 6, padding: '4px 10px', fontSize: 13 }}>
                  再解析
                </button>
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
                  {/* 既存のつながり → 選ぶとその人に情報が重なる。候補にだけいる新規の人も並べる */}
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
                const ok = await confirm('解析結果を破棄して録り直しますか？');
                if (!ok) return;
                setPhase('idle');
                setProposals(EMPTY);
                setMinutes(null);
                setWarnings([]);
                setMeetingId(null);
                setSpeakers([]);
                setSpeakerNames({});
                setPending(null);
                setUploadedPath(null);
                setError(null);
              }}
              backLabel="録り直す"
              minutes={minutes}
              onMinutesChange={setMinutes}
              allowAddPerson
            />
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

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
