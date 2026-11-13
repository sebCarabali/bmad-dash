import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AiContext, AiTask, BASE_INSTRUCTIONS, QUICK_TASK_MAX_TOKENS, projectContext, taskInstructions } from './ai.prompts';

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const TASKS: AiTask[] = ['chat', 'draft-story', 'review-story'];

interface ChatBody {
  task?: AiTask;
  model?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  context?: AiContext;
}

/**
 * Proxy hacia la API de Claude con la API key de cada usuario (cabecera x-anthropic-key).
 * La key no se guarda ni se registra en el servidor.
 */
@Controller('ai')
export class AiController {
  private client(key?: string) {
    const apiKey = (key ?? '').trim();
    if (!apiKey) throw new UnauthorizedException('Configura tu API key de Anthropic en el asistente.');
    return new Anthropic({ apiKey, maxRetries: 1, timeout: 55_000 });
  }

  /** Comprueba que la key es válida sin consumir tokens. */
  @Post('validate')
  @HttpCode(200)
  async validate(@Headers('x-anthropic-key') key: string) {
    try {
      await this.client(key).models.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      const e = friendlyError(err);
      throw new BadRequestException(e.message);
    }
  }

  /** Respuesta en streaming como NDJSON: {type:'text'|'done'|'error', ...} por línea. */
  @Post('chat')
  async chat(@Headers('x-anthropic-key') key: string, @Body() body: ChatBody, @Res() res: Response) {
    const task: AiTask = TASKS.includes(body?.task as AiTask) ? (body.task as AiTask) : 'chat';
    const model = MODELS.includes(body?.model ?? '') ? body.model : MODELS[0];
    const ctx = body?.context ?? {};
    let messages = (body?.messages ?? [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }));
    if (task === 'draft-story') messages = [{ role: 'user', content: 'Redacta la especificación de la historia según las instrucciones.' }];
    if (task === 'review-story') messages = [{ role: 'user', content: 'Revisa el borrador de la historia según las instrucciones.' }];
    if (!messages.length || messages[messages.length - 1].role !== 'user') throw new BadRequestException('Falta el mensaje del usuario.');
    while (messages.length && messages[0].role !== 'user') messages.shift();

    const client = this.client(key);
    const extra = taskInstructions(task, ctx);
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: BASE_INSTRUCTIONS },
      // Bloque grande y estable: se cachea entre turnos del chat (prompt caching)
      { type: 'text', text: projectContext(ctx), cache_control: { type: 'ephemeral' } },
    ];
    if (extra) system.push({ type: 'text', text: extra });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj: unknown) => res.write(JSON.stringify(obj) + '\n');

    let aborted = false;
    res.on('close', () => (aborted = true));
    try {
      const stream = client.messages.stream({ model, max_tokens: QUICK_TASK_MAX_TOKENS[task], system, messages });
      res.on('close', () => {
        if (!res.writableEnded) stream.abort();
      });
      stream.on('text', (delta) => {
        if (!aborted) send({ type: 'text', text: delta });
      });
      const final = await stream.finalMessage();
      send({
        type: 'done',
        model: final.model,
        stopReason: final.stop_reason,
        usage: {
          input: final.usage.input_tokens,
          output: final.usage.output_tokens,
          cacheRead: final.usage.cache_read_input_tokens ?? 0,
          cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
        },
      });
    } catch (err) {
      if (!aborted) send({ type: 'error', ...friendlyError(err) });
    } finally {
      res.end();
    }
  }
}

function friendlyError(err: unknown): { message: string; status?: number } {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
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
    const detail = status === 400 ? `: ${err.message}` : '';
    return { message: base + detail, status };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { message: 'Claude tardó demasiado en responder. Prueba con una pregunta más corta o con Haiku.' };
  if (err instanceof Anthropic.APIConnectionError) return { message: 'No se pudo conectar con la API de Claude.' };
  return { message: (err as Error)?.message ?? 'Error desconocido' };
}
