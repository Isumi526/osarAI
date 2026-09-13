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
import { uploadMeetingAudio, ingestMeeting, commitMeeting, type MeetingCapture, type Speaker } from '../lib/meeting.js';
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
  // PCでシステム音声を録れるなら透明モード。無理ならスマホのスピーカー録音にフォールバック。
  const mode: 'pc' | 'mobile' | 'none' = pcRec.supported ? 'pc' : micRec.supported ? 'mobile' : 'none';
  const [gate, setGate] = useState<Gate>('checking');
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
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
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
    if (phase === 'recording') document.title = `● 録音中 ${fmt(elapsed)} | osarAI`;
  }, [phase, elapsed]);
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
    } else if (mode === 'mobile') {
      const r = await micRec.start({ audioBitsPerSecond: MOBILE_BITRATE });
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
        setMeetingId(res.meetingId);
        setProposals(res.proposals ?? EMPTY);
        setMinutes(res.minutes ?? '');
        setWarnings(res.warnings ?? []);
        setSpeakers(res.speakers ?? []);
        const initNames: Record<string, string> = {};
        for (const s of res.speakers ?? []) initNames[s.label] = s.isSelf ? '自分' : '';
        setSpeakerNames(initNames);
        setPhase('reviewing');
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
    const exists = proposals.people.some((p) => normalize(p.name) === normalize(nm));
    if (exists) return;
    setProposals({
      ...proposals,
      people: [...proposals.people, { customer_id: null, name: nm, points: [], needs: [], next_actions: [], custom_fields: {} }],
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
      const res = await commitMeeting({ meetingId, proposals, minutes, speakerNames });
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
            <Card title="使い方（パソコン・Zoomアプリ）">
              <ol style={listStyle}>
                <li>Zoom を開いたまま「録音を開始」を押す</li>
                <li>
                  共有ダイアログで<b>「画面全体」</b>を選び、<b>「システム音声を共有」をON</b>にして共有
                  <span style={{ display: 'block', fontSize: 12 }}>
                    （Zoom をブラウザで開いている場合は、その<b>タブ</b>を選び「タブの音声も共有」をON）
                  </span>
                </li>
                <li>会議が終わったら「収録を終了」。Zoom を先に閉じても録音は残ります</li>
              </ol>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '8px 0 0' }}>
                相手にはボットも通知も一切表示されません。イヤホン推奨（スピーカーだと相手の声がマイクにも入り、話者の区別が付きにくくなります）。
                システム音声の共有は Chrome 141 以降・macOS 14.2 以降で利用できます。初回は macOS の「画面収録」の許可が必要です。
              </p>
            </Card>
            <button type="button" onClick={onStart} style={{ minHeight: 52, fontSize: 16 }}>
              録音を開始
            </button>
          </>
        )}

        {phase === 'idle' && gate === 'ok' && mode === 'mobile' && (
          <>
            <Card title="使い方（スマホ・タブレット）">
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

        {phase === 'recording' && (
          <section style={{ display: 'grid', gap: 16, placeItems: 'center', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#c0392b', display: 'inline-block' }} />
              {pcRec.shareEnded ? '録音済み（共有が終了しました）' : '録音中'}
            </div>
            <div style={{ fontSize: 32, fontVariantNumeric: 'tabular-nums' }}>{fmt(elapsed)}</div>
            {pcRec.shareEnded && (
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
                画面共有が終了したため、ここまでの録音を保持しています。「収録を終了」で解析に進んでください。
              </p>
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
                        placeholder="お名前（相手）"
                        style={{ padding: 8, fontSize: 14 }}
                      />
                    )}
                  </label>
                ))}
                <datalist id="meeting-people">
                  {proposals.people
                    .filter((p) => p.name.trim())
                    .map((p, i) => (
                      <option key={i} value={p.name} />
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

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
