import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AiContext, AiTask, baseInstructions, BUDGETS, QUICK_TASK_MAX_TOKENS, sectionsBlock, sprintStateBlock, stableDocsBlock, taskInstructions } from './ai.prompts';
import { GroqError, groqModels, groqStream } from './groq.client';

type Provider = 'groq' | 'claude';
const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const TASKS: AiTask[] = ['chat', 'draft-story', 'review-story'];
/** Groq gratis tiene poco cupo por minuto: respuestas más cortas e historial recortado. */
const GROQ_MAX_TOKENS: Record<AiTask, number> = { chat: 1500, 'draft-story': 2200, 'review-story': 1200 };

interface ChatBody {
  provider?: Provider;
  task?: AiTask;
  model?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  context?: AiContext;
}

/**
 * Proxy hacia Groq o Claude con la API key de cada usuario (cabecera x-ai-key).
 * La key no se guarda ni se registra en el servidor.
 */
@Controller('ai')
export class AiController {
  private key(raw?: string, provider: Provider = 'groq') {
    const k = (raw ?? '').trim();
    if (!k) throw new UnauthorizedException(`Configura tu API key de ${provider === 'groq' ? 'Groq' : 'Anthropic'} en el asistente.`);
    return k;
  }

  /** Verifica la key y devuelve los modelos disponibles. */
  @Post('validate')
  @HttpCode(200)
  async validate(@Headers('x-ai-key') aiKey: string, @Headers('x-anthropic-key') legacyKey: string, @Body() body: { provider?: Provider }) {
    const provider: Provider = body?.provider === 'claude' ? 'claude' : 'groq';
    const key = this.key(aiKey || legacyKey, provider);
    try {
      if (provider === 'groq') return { ok: true, models: await groqModels(key) };
      await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
      return { ok: true, models: CLAUDE_MODELS };
    } catch (err) {
      throw new BadRequestException(friendlyError(err).message);
    }
  }

  /** Respuesta en streaming como NDJSON: {type:'text'|'done'|'error', ...} por línea. */
  @Post('chat')
  async chat(@Headers('x-ai-key') aiKey: string, @Headers('x-anthropic-key') legacyKey: string, @Body() body: ChatBody, @Res() res: Response) {
    const provider: Provider = body?.provider === 'claude' ? 'claude' : 'groq';
    const task: AiTask = TASKS.includes(body?.task as AiTask) ? (body.task as AiTask) : 'chat';
    const ctx = body?.context ?? {};
    const budget = BUDGETS[provider];
    const historyLimit = provider === 'groq' ? 6 : 20;
    const msgChars = provider === 'groq' ? 3_000 : 20_000;

    let messages = (body?.messages ?? [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-historyLimit)
      .map((m) => ({ role: m.role, content: m.content.slice(0, msgChars) }));
    if (task === 'draft-story') messages = [{ role: 'user', content: 'Redacta la especificación de la historia según las instrucciones.' }];
    if (task === 'review-story') messages = [{ role: 'user', content: 'Revisa el borrador de la historia según las instrucciones.' }];
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') throw new BadRequestException('Falta el mensaje del usuario.');

    const key = this.key(aiKey || legacyKey, provider);
    // Orden pensado para la caché de prompts: lo estable primero, lo que cambia en cada consulta al final.
    const base = baseInstructions(ctx);
    let stable = stableDocsBlock(ctx, budget);
    let sprint = sprintStateBlock(ctx, budget);
    let sections = sectionsBlock(ctx, budget);
    const extra = taskInstructions(task, ctx, budget);
    // Groq gratis: ~8K tokens por minuto entre entrada y salida. Tope de ~5K tokens para el contexto.
    if (provider === 'groq') {
      const MAX = 20_000;
      const total = () => base.length + stable.length + sprint.length + sections.length + extra.length;
      let n = ctx.sections?.length ?? 0;
      while (total() > MAX && n > 0) sections = sectionsBlock({ ...ctx, sections: ctx.sections.slice(0, --n) }, budget);
      if (total() > MAX) stable = stable.slice(0, Math.max(0, MAX - (total() - stable.length))) ;
      if (total() > MAX) sprint = sprint.slice(0, Math.max(3_000, MAX - (total() - sprint.length))) + '\n…[estado recortado]';
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');
    const abort = new AbortController();
    let closed = false;
    res.on('close', () => {
      closed = true;
      if (!res.writableEnded) abort.abort();
    });

    try {
      if (provider === 'groq') {
        const r = await groqStream({
          key,
          model: body?.model || 'openai/gpt-oss-120b',
          system: [base, stable, sprint, sections, extra].filter(Boolean).join('\n\n'),
          messages,
          maxTokens: GROQ_MAX_TOKENS[task],
          onText: (t) => !closed && send({ type: 'text', text: t }),
          signal: abort.signal,
        });
        send({ type: 'done', provider, model: r.model, stopReason: r.stopReason, usage: r.usage });
      } else {
        const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 55_000 });
        // Puntos de caché: tras el contexto permanente y tras el estado del sprint.
        // Las secciones y la tarea (cambian en cada consulta) van después, sin caché.
        const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: base }];
        if (stable) system.push({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
        system.push({ type: 'text', text: sprint, cache_control: { type: 'ephemeral' } });
        const tail = [sections, extra].filter(Boolean).join('\n\n');
        if (tail) system.push({ type: 'text', text: tail });
        const model = CLAUDE_MODELS.includes(body?.model ?? '') ? body.model : CLAUDE_MODELS[0];
        const stream = client.messages.stream({ model, max_tokens: QUICK_TASK_MAX_TOKENS[task], system, messages }, { signal: abort.signal });
        stream.on('text', (delta) => !closed && send({ type: 'text', text: delta }));
        const final = await stream.finalMessage();
        send({
          type: 'done',
          provider,
          model: final.model,
          stopReason: final.stop_reason,
          usage: {
            input: final.usage.input_tokens,
            output: final.usage.output_tokens,
            cacheRead: final.usage.cache_read_input_tokens ?? 0,
            cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
          },
        });
      }
    } catch (err) {
      if (!closed) send({ type: 'error', ...friendlyError(err) });
    } finally {
      res.end();
    }
  }
}

function friendlyError(err: unknown): { message: string; status?: number; retryAfter?: number; code?: string } {
  if (err instanceof GroqError) return { message: err.message, status: err.status, retryAfter: err.retryAfter };
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const apiMessage: string = (err as any).error?.error?.message ?? (err as any).error?.message ?? err.message ?? '';
    if (/credit balance/i.test(apiMessage)) {
      return {
        status,
        code: 'no_credits',
        message: 'Tu cuenta de Anthropic no tiene créditos para la API. Recarga en console.anthropic.com → Settings → Billing, o usa Groq (gratis).',
      };
    }
    const msg: Record<number, string> = {
      400: 'Petición rechazada por la API de Claude',
      401: 'API key de Anthropic inválida o revocada.',
      403: 'Tu API key no tiene permiso para este modelo o recurso.',
      404: 'Modelo no disponible para tu cuenta.',
      413: 'El contexto es demasiado grande. Desactiva los documentos de planificación e inténtalo de nuevo.',
      429: 'Límite de uso alcanzado en tu cuenta de Anthropic. Espera un momento.',
      529: 'Claude está saturado en este momento. Reintenta en unos segundos.',
    };
    const base = msg[status ?? 0] ?? `Error de la API de Claude (${status ?? 'sin estado'})`;
    return { message: base + (status === 400 && apiMessage ? `: ${apiMessage}` : ''), status };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { message: 'Claude tardó demasiado en responder. Prueba con una pregunta más corta o con Haiku.' };
  if (err instanceof Anthropic.APIConnectionError) return { message: 'No se pudo conectar con la API de Claude.' };
  return { message: (err as Error)?.message ?? 'Error desconocido' };
}
