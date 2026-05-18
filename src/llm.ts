import { config } from './config.js';

export type Tier = 'flash' | 'pro';

interface GeminiPart { text?: string }
interface GeminiContent { parts?: GeminiPart[] }
interface GeminiCandidate { content?: GeminiContent }
interface GeminiResponse { candidates?: GeminiCandidate[] }

interface CallArgs {
  model: string;
  contents: string;
  systemInstruction?: string;
  responseSchema?: unknown;
}

async function callGemini(args: CallArgs): Promise<string> {
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent?key=${config.gemini.apiKey}`;
  const generationConfig: Record<string, unknown> = { temperature: 0.3 };
  if (args.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = args.responseSchema;
  }
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: args.contents }] }],
    generationConfig,
  };
  if (args.systemInstruction) {
    body.systemInstruction = { parts: [{ text: args.systemInstruction }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`gemini ${args.model} ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as GeminiResponse;
  return json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

function modelFor(tier: Tier): string {
  return tier === 'pro' ? config.gemini.proModel : config.gemini.flashModel;
}

export async function generateText(args: {
  tier: Tier;
  systemInstruction?: string;
  prompt: string;
}): Promise<string> {
  return callGemini({
    model: modelFor(args.tier),
    contents: args.prompt,
    systemInstruction: args.systemInstruction,
  });
}

export async function generateJson<T>(args: {
  tier: Tier;
  systemInstruction?: string;
  prompt: string;
  schema: unknown;
}): Promise<T> {
  const text = await callGemini({
    model: modelFor(args.tier),
    contents: args.prompt,
    systemInstruction: args.systemInstruction,
    responseSchema: args.schema,
  });
  return JSON.parse(text) as T;
}
