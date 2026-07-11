// Gemini 呼び出しラッパー（サーバー専用・§8）。
// - APIキーはサーバーのみ。クライアントから直接叩かない（§4/§15）。
// - REST(generateContent)を fetch で叩く＝SDK依存なし。
// - JSON が要る用途は responseMimeType=application/json + responseSchema で構造を強制。
// モデル選定（§8末尾）：対話の質が要る所は Flash、抽出/要約/相談は Flash-Lite。
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_MODEL_DIALOGUE = process.env.GEMINI_MODEL_DIALOGUE ?? 'gemini-flash-latest';
export const GEMINI_MODEL_LITE = process.env.GEMINI_MODEL_LITE ?? 'gemini-flash-lite-latest';

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY 未設定');
  return k;
}

// Geminiは「high demand」等の一時的な503/429を返すことがある（実運用で確認済み）。
// 呼び出し側に生のエラーをそのまま投げず、ここで吸収する：
// (1) 短い間隔でリトライ (2) それでも駄目ならFlash-Liteにフォールバック。
// 参照: apps/web/app/api/osarai/turn/route.ts 等はこの関数経由でのみGeminiを呼ぶ。
class GeminiApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_STATUS = 504; // fetch自体がタイムアウトした時の疑似ステータス（リトライ対象に含める）
const RETRIABLE_STATUSES = new Set([429, 500, 503, TIMEOUT_STATUS]);
const RETRY_DELAYS_MS = [800]; // 1回だけ短い間隔でリトライ（呼び出し元のタイムアウト予算を圧迫しすぎない）

function isRetriable(e: unknown): boolean {
  return e instanceof GeminiApiError && RETRIABLE_STATUSES.has(e.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Geminiは混雑時、エラーを返さずリクエストを掴んだまま長時間応答しないことがある
 * （実運用で単発呼び出しが40秒超かかった実績あり）。fetch自体にタイムアウトが無いと
 * サーバーレス関数のmaxDurationを超えて丸ごと落ちる。ここで各試行を打ち切り、
 * リトライ/フォールバックに回す。
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new GeminiApiError(TIMEOUT_STATUS, `Gemini呼び出しが${timeoutMs}ms以内に応答しませんでした`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * リトライ＋モデルフォールバック付きの実行ラッパー。
 * primaryModel で（リトライ込みで）試し、それでも一時的エラーが続く場合のみ
 * fallbackModel（既定Flash-Lite）へ1回だけ切り替えて試す。
 */
async function withRetryAndFallback<T>(
  run: (model: string) => Promise<T>,
  primaryModel: string,
  fallbackModel: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await run(primaryModel);
    } catch (e) {
      lastErr = e;
      if (!isRetriable(e) || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
  if (primaryModel !== fallbackModel && isRetriable(lastErr)) {
    try {
      return await run(fallbackModel);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Gemini の responseSchema は OpenAPI サブセット。最小限の型だけ用意。
export type GeminiSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
};

interface GenerateOpts {
  model?: string;
  system?: string;
  /** JSON 強制したい時に渡す。渡すと文字列ではなくパース済みオブジェクトを返す。 */
  jsonSchema?: GeminiSchema;
  temperature?: number;
}

/** プレーンテキスト生成。 */
export async function geminiText(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  const res = await callGenerate(prompt, opts);
  return res;
}

/** JSON 生成（responseSchema 強制）。パース済みオブジェクトを返す。 */
export async function geminiJson<T>(prompt: string, schema: GeminiSchema, opts: GenerateOpts = {}): Promise<T> {
  const raw = await callGenerate(prompt, { ...opts, jsonSchema: schema });
  try {
    return JSON.parse(raw) as T;
  } catch {
    // まれにコードフェンス等が混ざるため救済
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Gemini JSON パース失敗: ${raw.slice(0, 200)}`);
  }
}

/**
 * 画像＋指示からJSON抽出（顧客登録AI解析・自己紹介シート画像等）。inline_data で画像を渡す。
 * 短尺の画像向け（inline は ~20MB まで）。
 */
export async function geminiJsonFromImage<T>(
  imageBase64: string,
  mimeType: string,
  instruction: string,
  schema: GeminiSchema,
  opts: { model?: string } = {},
): Promise<T> {
  const primaryModel = opts.model ?? GEMINI_MODEL_LITE;

  const runOnce = async (model: string): Promise<string> => {
    const res = await fetchWithTimeout(
      `${API_BASE}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: instruction }],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
      },
      30_000,
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new GeminiApiError(res.status, `Gemini image ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
  };

  const raw = await withRetryAndFallback(runOnce, primaryModel, GEMINI_MODEL_LITE);
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Gemini 画像JSON パース失敗: ${raw.slice(0, 200)}`);
  }
}

/**
 * 音声の文字起こし（§8-1 音声入力 / §8-2）。inline_data で音声を渡す。
 * 短尺の発話向け（inline は ~20MB まで）。長尺は将来 Files API + 非同期に。
 * コスト優先で Flash-Lite を既定に。
 */
export async function geminiTranscribe(
  audioBase64: string,
  mimeType: string,
  opts: { model?: string; language?: string } = {},
): Promise<string> {
  const primaryModel = opts.model ?? GEMINI_MODEL_LITE;
  const instruction =
    `次の音声を${opts.language ?? '日本語'}で文字起こししてください。` +
    `話し言葉のまま、要約や解説は一切付けず、発話内容のテキストだけを返してください。`;

  const runOnce = async (model: string): Promise<string> => {
    const t0 = Date.now();
    const res = await fetchWithTimeout(
      `${API_BASE}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ inlineData: { mimeType, data: audioBase64 } }, { text: instruction }],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
      },
      // 実測(約30秒の実発話)では数秒〜10秒程度で完了するため25秒に短縮。
      // 45秒のままだと、リトライ1回込みで最悪91秒待たされてしまう(体感の遅さの一因)。
      25_000,
    );
    console.log(`[geminiTranscribe] model=${model} elapsed=${Date.now() - t0}ms`);
    if (!res.ok) {
      const detail = await res.text();
      throw new GeminiApiError(res.status, `Gemini STT ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
  };

  // 文字起こしは元々Flash-Lite（フォールバック先と同じ）なので、リトライのみでフォールバックは無意味
  return withRetryAndFallback(runOnce, primaryModel, primaryModel);
}

async function callGenerate(prompt: string, opts: GenerateOpts): Promise<string> {
  const primaryModel = opts.model ?? GEMINI_MODEL_DIALOGUE;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      ...(opts.jsonSchema
        ? { responseMimeType: 'application/json', responseSchema: opts.jsonSchema }
        : {}),
    },
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  const runOnce = async (model: string): Promise<string> => {
    const res = await fetchWithTimeout(
      `${API_BASE}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify(body),
      },
      15_000,
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new GeminiApiError(res.status, `Gemini ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim();
  };

  return withRetryAndFallback(runOnce, primaryModel, GEMINI_MODEL_LITE);
}
