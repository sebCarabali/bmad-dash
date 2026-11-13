/**
 * Cliente mínimo para la API de Groq (compatible con OpenAI Chat Completions, streaming SSE).
 * https://console.groq.com/docs
 */
export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';

/** Modelos preferidos para el asistente, en orden (se cruzan con los que tu cuenta tiene disponibles). */
export const GROQ_PREFERRED = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'];

export class GroqError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export interface GroqUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

async function groqFetch(key: string, path: string, init: RequestInit = {}, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`${GROQ_BASE_URL}${path}`, {
      ...init,
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new GroqError('No se pudo conectar con la API de Groq.');
  }
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw groqHttpError(res.status, body?.error?.message ?? '', res.headers.get('retry-after'));
  }
  return res;
}

function groqHttpError(status: number, apiMessage: string, retryAfterHeader: string | null): GroqError {
  const retryAfter = retryAfterHeader ? Math.ceil(Number(retryAfterHeader)) || undefined : undefined;
  const wait = retryAfter ? ` Espera ~${retryAfter} s.` : ' Espera un momento.';
  const tooLarge = /request too large|tokens per minute|TPM|context.length|maximum context/i.test(apiMessage);
  if (status === 401) return new GroqError('API key de Groq inválida o revocada.', status);
  if (status === 403) return new GroqError('Tu API key de Groq no tiene acceso a este modelo.', status);
  if (status === 404) return new GroqError('Modelo no disponible en Groq. Elige otro en el selector.', status);
  if (status === 413 || (status === 429 && tooLarge) || (status === 400 && tooLarge))
    return new GroqError(
      'La petición supera el límite de tokens del plan gratuito de Groq. Desactiva "Incluir PRD y arquitectura", inicia una conversación nueva o usa un modelo con más cupo.',
      status,
      retryAfter,
    );
  if (status === 429) {
    const daily = /per day|RPD|TPD/i.test(apiMessage);
    return new GroqError(
      daily ? 'Alcanzaste el límite diario gratuito de Groq para este modelo. Prueba otro modelo o vuelve mañana.' : `Límite por minuto del plan gratuito de Groq alcanzado.${wait}`,
      status,
      retryAfter,
    );
  }
  if (status === 498) return new GroqError('Groq está sin capacidad para este modelo en este momento. Prueba otro modelo.', status);
  if (status >= 500) return new GroqError('Groq tuvo un error temporal. Reintenta en unos segundos.', status);
  return new GroqError(`Petición rechazada por Groq${apiMessage ? `: ${apiMessage}` : ''}`, status);
}

/** Lista los modelos de chat disponibles para la key (y verifica que sea válida). */
export async function groqModels(key: string): Promise<string[]> {
  const res = await groqFetch(key, '/models');
  const body: any = await res.json();
  const ids: string[] = (body?.data ?? [])
    .filter((m: any) => m?.active !== false)
    .map((m: any) => String(m.id))
    .filter((id: string) => !/whisper|tts|playai|orpheus|guard|safeguard|prompt-guard|distil|embed|compound/i.test(id));
  const preferred = GROQ_PREFERRED.filter((p) => ids.includes(p));
  return [...preferred, ...ids.filter((i) => !preferred.includes(i)).sort()];
}

export interface GroqStreamParams {
  key: string;
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

/** Stream de chat: llama a onText por cada fragmento y devuelve el uso de tokens. */
export async function groqStream(p: GroqStreamParams): Promise<{ model: string; stopReason?: string; usage: GroqUsage }> {
  const body: Record<string, unknown> = {
    model: p.model,
    stream: true,
    max_completion_tokens: p.maxTokens,
    messages: [{ role: 'system', content: p.system }, ...p.messages],
  };
  // Los modelos gpt-oss razonan antes de responder: esfuerzo bajo para ahorrar cupo de tokens
  if (/gpt-oss/i.test(p.model)) body.reasoning_effort = 'low';

  const res = await groqFetch(p.key, '/chat/completions', { method: 'POST', body: JSON.stringify(body) }, p.signal);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage: GroqUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: string | undefined;
  let model = p.model;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw groqHttpError(Number(chunk.error.status ?? 500), chunk.error.message ?? '', null);
      model = chunk.model ?? model;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) p.onText(delta);
      if (choice?.finish_reason) stopReason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;
      const u = chunk.x_groq?.usage ?? chunk.usage;
      if (u) {
        usage = {
          input: u.prompt_tokens ?? 0,
          output: u.completion_tokens ?? 0,
          cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWrite: 0,
        };
        usage.input = Math.max(0, usage.input - usage.cacheRead);
      }
    }
  }
  return { model, stopReason, usage };
}
