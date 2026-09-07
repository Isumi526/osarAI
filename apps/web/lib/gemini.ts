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
  opts: { model?: string; language?: string; cleanFillers?: boolean } = {},
): Promise<string> {
  const primaryModel = opts.model ?? GEMINI_MODEL_LITE;
  // フィラー除去は文字起こしと同じ1回の呼び出しで行う（別途LLMで後処理すると
  // 待ち時間が二重にかかるため。2026-08-06 UI/UX刷新の音声補正）。
  const cleanup =
    opts.cleanFillers === false
      ? ''
      : `「えーと」「あー」「その」「なんか」のようなフィラーや、言い直しで生じた不要な断片は取り除いてください。` +
        `ただし話し言葉の自然さは保ち、内容の要約・言い換え・補完はしないでください（言っていないことを足さない）。`;
  const instruction =
    `次の音声を${opts.language ?? '日本語'}で文字起こししてください。` +
    cleanup +
    `要約や解説は一切付けず、発話内容のテキストだけを返してください。`;

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

const UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

/** Files API へ音声をレジューム可能アップロードし、参照用の uri / name を返す。 */
async function uploadFileToGemini(bytes: Uint8Array, mimeType: string): Promise<{ uri: string; name: string }> {
  const key = apiKey();
  const numBytes = String(bytes.byteLength);
  // 1) レジューマブルセッション開始（メタデータのみ・アップロードURLを受け取る）
  const start = await fetchWithTimeout(
    UPLOAD_URL,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': numBytes,
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'meeting-audio' } }),
    },
    30_000,
  );
  if (!start.ok) {
    throw new GeminiApiError(start.status, `Files start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API: アップロードURLが返りませんでした');
  // 2) 本体アップロード＋finalize
  const up = await fetchWithTimeout(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'content-length': numBytes,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      // undici/lib.dom の BodyInit 型は Uint8Array<ArrayBufferLike> を厳密拒否する（TS5.7系の
      // SharedArrayBuffer 区別）。実行時は undici が Uint8Array を受けるためキャストで通す。
      body: bytes as unknown as BodyInit,
    },
    180_000,
  );
  if (!up.ok) {
    throw new GeminiApiError(up.status, `Files upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  }
  const data = (await up.json()) as { file?: { uri?: string; name?: string } };
  const uri = data.file?.uri;
  const name = data.file?.name;
  if (!uri || !name) throw new Error('Files API: uri/name が返りませんでした');
  return { uri, name };
}

/** 音声ファイルは非同期に処理される。ACTIVE になるまで待つ（FAILED は即エラー）。 */
async function waitForFileActive(name: string, timeoutMs = 90_000): Promise<void> {
  const key = apiKey();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`${API_BASE}/${name}`, { headers: { 'x-goog-api-key': key } }, 15_000);
    if (res.ok) {
      const j = (await res.json()) as { state?: string };
      if (j.state === 'ACTIVE') return;
      if (j.state === 'FAILED') throw new Error('Files API: 音声処理に失敗しました(FAILED)');
    }
    await sleep(2_000);
  }
  throw new GeminiApiError(TIMEOUT_STATUS, 'Files API: 音声がACTIVEになりませんでした（タイムアウト）');
}

/** best-effort でアップロード済みファイルを削除（Files は48hで自動失効するが明示削除する）。 */
async function deleteGeminiFile(name: string): Promise<void> {
  try {
    await fetchWithTimeout(`${API_BASE}/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey() } }, 15_000);
  } catch {
    /* 失効任せで問題ない */
  }
}

/**
 * 長尺音声の文字起こし（会議録音・T0）。inline(~20MB)上限を避けるため Files API 経由で渡す。
 * 1時間級の会議でも 25MB 制限で落ちない。processing 完了待ち＋長めのタイムアウトを取る。
 */
export async function geminiTranscribeLong(
  bytes: Uint8Array,
  mimeType: string,
  opts: { model?: string; language?: string; cleanFillers?: boolean; channelSelfLeft?: boolean } = {},
): Promise<string> {
  const model = opts.model ?? GEMINI_MODEL_LITE;
  const cleanup =
    opts.cleanFillers === false
      ? ''
      : `「えーと」「あー」「その」「なんか」のようなフィラーや、言い直しで生じた不要な断片は取り除いてください。` +
        `ただし話し言葉の自然さは保ち、内容の要約・言い換え・補完はしないでください（言っていないことを足さない）。`;
  // 話者ラベル付け（T4）。PC録音は2chステレオ（左=自分/右=相手）なので、その前提で
  // 「自分」と「相手1/相手2…」を割り当てさせる。それ以外は話者A/B/Cで分離のみ。
  const diarization = opts.channelSelfLeft
    ? `この音声は2chステレオで、左チャンネルが録音者本人（あなたの利用者=「自分」）、右チャンネルが相手です。` +
      `話者が替わったら改行し、行頭に「自分:」または相手が複数なら「相手1:」「相手2:」のようにラベルを付けてください。`
    : `複数人が話している場合は、話者が替わったら改行し、可能なら行頭に「話者A:」「話者B:」のように話者ラベルを付けてください（誰かは特定しなくてよい）。`;
  const instruction =
    `次の会議音声を${opts.language ?? '日本語'}で文字起こししてください。` +
    diarization +
    cleanup +
    `要約や解説は一切付けず、発話内容のテキストだけを返してください。`;

  const { uri, name } = await uploadFileToGemini(bytes, mimeType);
  try {
    await waitForFileActive(name);
    const runOnce = async (m: string): Promise<string> => {
      const res = await fetchWithTimeout(
        `${API_BASE}/models/${m}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ fileData: { mimeType, fileUri: uri } }, { text: instruction }] }],
            generationConfig: { temperature: 0 },
          }),
        },
        // 長尺は生成にも時間がかかる。ルート側 maxDuration と整合させる。
        240_000,
      );
      if (!res.ok) {
        throw new GeminiApiError(res.status, `Gemini STT(long) ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
    };
    return await withRetryAndFallback(runOnce, model, model);
  } finally {
    void deleteGeminiFile(name);
  }
}

async function callGenerate(prompt: string, opts: GenerateOpts): Promise<string> {
  const primaryModel = opts.model ?? GEMINI_MODEL_DIALOGUE;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      // gemini-flash-latest/gemini-flash-lite-latestは既定でthinkingが有効になり、対話1
      // ターンごとに数秒〜十数秒の余計な遅延が乗る。おさらい対話/自分をおさらいは1問1答の
      // 抽出＋短い次の質問生成が主でthinkingの恩恵が薄いため、体感速度を優先し最小に絞る。
      // 注意: thinkingBudget=0は2026-07時点で"-latest"エイリアスの参照先モデルが変わって
      // 以降 400 INVALID_ARGUMENT で拒否される（本番のAIチャット全滅の実障害原因）。
      // 1(最小の非ゼロ値)なら現行モデルで受理されることを実APIで確認済み。
      thinkingConfig: { thinkingBudget: 1 },
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

/**
 * Gemini の疎通確認（本番スモーク用）。最小のプロンプトで応答可否だけを見る。
 * 目的は「モデル側の変更やキー失効でAI機能が黙って壊れる」のを早く知ること
 * （実際にモデル更新でおさらいのAIが本番で止まった経験がある）。
 * コストを増やさないよう出力は1語に制限し、呼び出し元はトークンで保護すること。
 */
export async function geminiPing(): Promise<{ ok: boolean; model: string; elapsedMs: number; detail?: string }> {
  const model = GEMINI_MODEL_LITE;
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ok とだけ返してください。' }] }],
          // 5トークンだと thinking 系モデルで本文が空になり「AIが落ちた」と誤判定しうるので少し余裕を持たせる
          generationConfig: { maxOutputTokens: 16, temperature: 0 },
        }),
      },
      15_000,
    );
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, model, elapsedMs, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim().length > 0
      ? { ok: true, model, elapsedMs }
      : { ok: false, model, elapsedMs, detail: 'empty response' };
  } catch (e) {
    return { ok: false, model, elapsedMs: Date.now() - t0, detail: String(e instanceof Error ? e.message : e) };
  }
}
