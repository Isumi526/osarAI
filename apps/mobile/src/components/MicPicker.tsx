// マイクの選択と事前テスト（2026-09-22）。
// 「自分の声が録音に入っていない」時、原因がアプリなのか OS のマイク設定なのかを
// ユーザー自身が切り分けられるようにする（Zoom の設定画面と同じ考え方）。
// 実際に起きた例: 常駐の音声入力アプリがマイクを掴む／iPhone の連携マイクが選ばれたまま切断される。
import { useCallback, useEffect, useRef, useState } from 'react';
import { readLevel } from '../hooks/useMeetingRecorder.js';

const STORAGE_KEY = 'osarai.micDeviceId';

export function getSavedMicId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // プライベートモード等
  }
}
function saveMicId(id: string) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 保存できなくても選択自体は効く */
  }
}

export function MicPicker({
  onChange,
  showTest = true,
  title = '自分の声を録るマイク',
}: {
  onChange?: (deviceId: string | null) => void;
  /** 録音中は事前テストを出さない（マイクを二重に掴まないため） */
  showTest?: boolean;
  title?: string;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<string>(() => getSavedMicId() ?? '');
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    try {
      // ラベル（機器名）は許可後でないと取れないので、先に許可を取る
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      setDevices(list);
      // 保存済みの機器が無くなっていたら（iPhone を切断した等）既定に戻す
      if (selected && !list.some((d) => d.deviceId === selected)) {
        setSelected('');
        saveMicId('');
        onChange?.(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    void load();
    const onDeviceChange = () => void load();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      stopRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleTest() {
    if (testing) {
      stopRef.current?.();
      return;
    }
    setError(null);
    setPeak(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selected ? { deviceId: { exact: selected } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(1024) as Float32Array<ArrayBuffer>;
      const timer = setInterval(() => {
        const v = readLevel(an, buf);
        setLevel(v);
        setPeak((p) => Math.max(p, v));
      }, 100);
      setTesting(true);
      stopRef.current = () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
        setTesting(false);
        setLevel(0);
        stopRef.current = null;
      };
      // 15秒で自動停止（止め忘れでマイクを掴み続けない）
      setTimeout(() => stopRef.current?.(), 15_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section style={{ padding: 16, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 12, display: 'grid', gap: 10 }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <select
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          setSelected(v);
          saveMicId(v);
          onChange?.(v || null);
          stopRef.current?.();
        }}
        style={{ padding: 10, fontSize: 14, borderRadius: 8, border: '1px solid var(--color-border)', background: '#fff' }}
      >
        <option value="">パソコンの既定のマイク</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `マイク ${i + 1}`}
          </option>
        ))}
      </select>

      {showTest && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={() => void toggleTest()}
          style={{ minHeight: 40, padding: '0 14px', fontSize: 13, background: '#fff', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          {testing ? 'テストを止める' : 'マイクをテスト'}
        </button>
        <div style={{ flex: 1, height: 10, background: 'var(--color-border)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: 'var(--color-primary)', transition: 'width 0.1s' }} />
        </div>
      </div>
      )}

      {showTest && testing && (
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
          {peak > 0.05 ? '✓ 声が届いています。このマイクで録音できます。' : '声を出してみてください。バーが動かない場合は別のマイクを選んでください。'}
        </p>
      )}
      {showTest && !testing && (
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
          声が入らない時はここでテストしてください。音声入力アプリ（常駐のディクテーション等）がマイクを掴んでいる場合や、
          iPhone の連携マイクが選ばれたまま切断された場合は、ここで別のマイクに変えると直ります。
        </p>
      )}
      {error && <p style={{ fontSize: 12, color: '#c0392b', margin: 0 }}>{error}</p>}
    </section>
  );
}
