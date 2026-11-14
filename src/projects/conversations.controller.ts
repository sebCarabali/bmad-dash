import { BadRequestException, Body, Controller, Delete, Get, Headers, InternalServerErrorException, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

type Role = 'user' | 'assistant' | 'system';
const ROLES: Role[] = ['user', 'assistant', 'system'];

interface NewMessage {
  role: Role;
  content: string;
  /** Mensajes de usuario: qué se envió como contexto (referencias, no contenido) */
  context?: unknown;
  /** Respuestas: tokens, proveedor y modelo */
  usage?: unknown;
  createdAt?: string;
}

/** Límite defensivo para el JSON de contexto/uso de un mensaje. */
function smallJson(v: unknown, max = 20_000): unknown {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  if (s.length > max) throw new BadRequestException('El contexto del mensaje es demasiado grande.');
  return JSON.parse(s);
}

function cleanMessages(list: NewMessage[] | undefined): NewMessage[] {
  if (!Array.isArray(list) || !list.length || list.length > 50) throw new BadRequestException('Envía entre 1 y 50 mensajes.');
  return list.map((m) => {
    if (!m || !ROLES.includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw new BadRequestException('Mensaje no válido.');
    return { role: m.role, content: m.content.slice(0, 100_000), context: smallJson(m.context), usage: smallJson(m.usage, 4_000), createdAt: m.createdAt };
  });
}

/**
 * Conversaciones del asistente guardadas en Supabase (RLS: cada usuario solo ve las suyas).
 * Una fila por mensaje: añadir nunca reescribe el hilo.
 */
@Controller()
export class ConversationsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get('projects/:id/conversations')
  async list(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) projectId: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client
      .from('ai_conversations')
      .select('id, title, provider, model, focus_story, message_count, tokens_in, tokens_out, created_at, updated_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(100);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  /** Crea una conversación, opcionalmente con sus primeros mensajes (también sirve para importar un JSON). */
  @Post('projects/:id/conversations')
  async create(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: { title?: string; provider?: string; model?: string; focusStory?: string; messages?: NewMessage[] },
  ) {
    const { client, user } = await this.supabase.user(auth);
    const messages = body?.messages?.length ? cleanMessages(body.messages) : [];
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
    const title = (body?.title || firstUser || 'Conversación').replace(/\s+/g, ' ').trim().slice(0, 80);
    const { data: conv, error } = await client
      .from('ai_conversations')
      .insert({ project_id: projectId, owner_id: user.id, title, provider: body?.provider ?? null, model: body?.model ?? null, focus_story: body?.focusStory ?? null })
      .select('id, title, created_at')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (messages.length) await this.insertMessages(client, user.id, conv.id, messages, 0);
    return { ...conv, messageCount: messages.length };
  }

  @Get('conversations/:cid')
  async get(@Headers('authorization') auth: string, @Param('cid', ParseUUIDPipe) cid: string) {
    const { client } = await this.supabase.user(auth);
    const { data: conv, error } = await client
      .from('ai_conversations')
      .select('id, project_id, title, provider, model, focus_story, message_count, tokens_in, tokens_out, created_at, updated_at')
      .eq('id', cid)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!conv) throw new NotFoundException('Conversación no encontrada.');
    const { data: messages, error: mErr } = await client
      .from('ai_messages')
      .select('seq, role, content, context, usage, created_at')
      .eq('conversation_id', cid)
      .order('seq', { ascending: true })
      .limit(2000);
    if (mErr) throw new InternalServerErrorException(mErr.message);
    return { conversation: conv, messages: messages ?? [] };
  }

  /** Añade mensajes al final del hilo. */
  @Post('conversations/:cid/messages')
  async append(
    @Headers('authorization') auth: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() body: { messages: NewMessage[]; provider?: string; model?: string; focusStory?: string | null },
  ) {
    const { client, user } = await this.supabase.user(auth);
    const messages = cleanMessages(body?.messages);
    const { data: last, error } = await client.from('ai_messages').select('seq').eq('conversation_id', cid).order('seq', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    const total = await this.insertMessages(client, user.id, cid, messages, last?.seq ?? 0);
    const patch: Record<string, unknown> = {};
    if (body?.provider) patch.provider = body.provider;
    if (body?.model) patch.model = body.model;
    if (body?.focusStory !== undefined) patch.focus_story = body.focusStory;
    if (Object.keys(patch).length) await client.from('ai_conversations').update(patch).eq('id', cid);
    return { appended: messages.length, messageCount: total };
  }

  @Patch('conversations/:cid')
  async rename(@Headers('authorization') auth: string, @Param('cid', ParseUUIDPipe) cid: string, @Body() body: { title: string }) {
    const { client } = await this.supabase.user(auth);
    const title = String(body?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) throw new BadRequestException('El título no puede estar vacío.');
    const { error } = await client.from('ai_conversations').update({ title }).eq('id', cid);
    if (error) throw new InternalServerErrorException(error.message);
    return { title };
  }

  @Delete('conversations/:cid')
  async remove(@Headers('authorization') auth: string, @Param('cid', ParseUUIDPipe) cid: string) {
    const { client } = await this.supabase.user(auth);
    const { error } = await client.from('ai_conversations').delete().eq('id', cid);
    if (error) throw new InternalServerErrorException(error.message);
    return { deleted: true };
  }

  private async insertMessages(client: any, ownerId: string, cid: string, messages: NewMessage[], startSeq: number) {
    const rows = messages.map((m, i) => ({
      conversation_id: cid,
      owner_id: ownerId,
      seq: startSeq + i + 1,
      role: m.role,
      content: m.content,
      context: m.context ?? null,
      usage: m.usage ?? null,
      ...(m.createdAt && !isNaN(Date.parse(m.createdAt)) ? { created_at: new Date(m.createdAt).toISOString() } : {}),
    }));
    const { error } = await client.from('ai_messages').insert(rows);
    if (error) throw new InternalServerErrorException(error.message);
    // Contadores del hilo (los recalcula a partir de los mensajes)
    const { data: all } = await client.from('ai_messages').select('usage').eq('conversation_id', cid);
    const tokensIn = (all ?? []).reduce((a: number, r: any) => a + (Number(r.usage?.input) || 0) + (Number(r.usage?.cacheRead) || 0) + (Number(r.usage?.cacheWrite) || 0), 0);
    const tokensOut = (all ?? []).reduce((a: number, r: any) => a + (Number(r.usage?.output) || 0), 0);
    await client.from('ai_conversations').update({ message_count: (all ?? []).length, tokens_in: tokensIn, tokens_out: tokensOut }).eq('id', cid);
    return (all ?? []).length;
  }
}
