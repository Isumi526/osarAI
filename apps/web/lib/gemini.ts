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
 * 音声の文字起こし（§8-1 音声入力 / §8-2）。inline_data で音声を渡す。
 * 短尺の発話向け（inline は ~20MB まで）。長尺は将来 Files API + 非同期に。
 * コスト優先で Flash-Lite を既定に。
 */
export async function geminiTranscribe(
  audioBase64: string,
  mimeType: string,
  opts: { model?: string; language?: string } = {},
): Promise<string> {
  const model = opts.model ?? GEMINI_MODEL_LITE;
  const instruction =
    `次の音声を${opts.language ?? '日本語'}で文字起こししてください。` +
    `話し言葉のまま、要約や解説は一切付けず、発話内容のテキストだけを返してください。`;

  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
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
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini STT ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
}

async function callGenerate(prompt: string, opts: GenerateOpts): Promise<string> {
  const model = opts.model ?? GEMINI_MODEL_DIALOGUE;
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

  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return text.trim();
}
