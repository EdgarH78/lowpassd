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

// ---- Function-calling / tool-use --------------------------------------------

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ResponsePart {
  text?: string;
  functionCall?: FunctionCall;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  // OpenAPI-subset JSON Schema describing the args.
  parameters: Record<string, unknown>;
}

// A turn in the conversation. Function results are sent as role 'user' with
// a `functionResponse` part — that's what Gemini expects.
export type ConversationPart =
  | { text: string }
  | { functionCall: FunctionCall }
  | { functionResponse: { name: string; response: unknown } };

export interface ConversationTurn {
  role: 'user' | 'model';
  parts: ConversationPart[];
}

export async function generateContentWithTools(args: {
  tier: Tier;
  systemInstruction?: string;
  contents: ConversationTurn[];
  tools: ToolDeclaration[];
}): Promise<{ parts: ResponsePart[] }> {
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  const model = modelFor(args.tier);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.gemini.apiKey}`;
  const body: Record<string, unknown> = {
    contents: args.contents,
    tools: [{ functionDeclarations: args.tools }],
    generationConfig: { temperature: 0.2 },
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
    throw new Error(`gemini ${model} ${res.status}: ${text.slice(0, 800)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: ResponsePart[] }; finishReason?: string; finishMessage?: string }>;
    promptFeedback?: unknown;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  if (parts.length === 0) {
    console.warn('[llm] tool-use call returned 0 parts', JSON.stringify({
      finishReason: json.candidates?.[0]?.finishReason,
      finishMessage: json.candidates?.[0]?.finishMessage,
      promptFeedback: json.promptFeedback,
      candidateCount: json.candidates?.length ?? 0,
    }));
  }
  return { parts };
}
