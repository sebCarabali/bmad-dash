import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, InternalServerErrorException, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

interface SyncBody {
  rootLabel: string;
  dashboard: any;
}

interface SpecRecordBody {
  storyId: string;
  storyKey?: string;
  title: string;
  status?: string;
  fileName?: string;
  markdown: string;
  quality?: unknown;
  savedToDisk?: boolean;
}

/** Proyectos, historial de snapshots y especificaciones guardadas en Supabase (por usuario, con RLS). */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list(@Headers('authorization') auth: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client
      .from('projects')
      .select('id, name, root_label, bmad_version, last_synced_at, created_at, snapshots(created_at, total_stories, done_stories, in_progress_stories, review_stories, tasks_total, tasks_done)')
      .order('last_synced_at', { ascending: false, nullsFirst: false })
      .order('created_at', { referencedTable: 'snapshots', ascending: false })
      .limit(1, { referencedTable: 'snapshots' });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map((p: any) => ({ ...p, latest: p.snapshots?.[0] ?? null, snapshots: undefined }));
  }

  /** Registra (o actualiza) el proyecto y guarda un snapshot si el estado cambió. */
  @Post('sync')
  @HttpCode(200)
  async sync(@Headers('authorization') auth: string, @Body() body: SyncBody) {
    const { client, user } = await this.supabase.user(auth);
    const d = body?.dashboard;
    if (!body?.rootLabel || !d?.stats || !Array.isArray(d?.stories)) throw new BadRequestException('Datos de sincronización incompletos.');
    const rootLabel = String(body.rootLabel).slice(0, 300);
    const now = new Date().toISOString();

    const { data: project, error: upErr } = await client
      .from('projects')
      .upsert({ owner_id: user.id, root_label: rootLabel, name: String(d.projectName ?? rootLabel).slice(0, 200), bmad_version: d.version ?? null, last_synced_at: now }, { onConflict: 'owner_id,root_label' })
      .select('id, name, root_label')
      .single();
    if (upErr) throw new InternalServerErrorException(upErr.message);

    const signature = createHash('sha1')
      .update(JSON.stringify({ s: d.stats, st: d.stories.map((s: any) => [s.id, s.status, s.tasksDone, s.tasksTotal, s.title]) }))
      .digest('hex');

    const { data: last } = await client
      .from('snapshots')
      .select('signature, stories:dashboard->stories')
      .eq('project_id', project.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.signature === signature) return { project, snapshotCreated: false, events: 0 };

    // Eventos de cambio de estado (base de las métricas del sprint)
    const prev = new Map<string, { status: string; title?: string }>(((last as any)?.stories ?? []).map((x: any) => [x.id, { status: x.status, title: x.title }]));
    const events: any[] = [];
    const ev = (story: any, from: string | null, to: string, kind: string) =>
      events.push({ project_id: project.id, owner_id: user.id, story_id: String(story.id).slice(0, 20), story_title: String(story.title ?? '').slice(0, 300), epic: Number(story.epic) || null, from_status: from, to_status: to, kind, occurred_at: now });
    for (const st of d.stories as any[]) {
      const p = prev.get(st.id);
      if (!last) ev(st, null, st.status, 'baseline');
      else if (!p) ev(st, null, st.status, 'change');
      else if (p.status !== st.status) ev(st, p.status, st.status, 'change');
    }
    if (last) for (const [id, p] of prev) if (!(d.stories as any[]).some((x) => x.id === id)) ev({ id, title: p.title, epic: id.split('.')[0] }, p.status, 'removed', 'removed');
    if (events.length) {
      const { error: evErr } = await client.from('story_events').insert(events);
      if (evErr) throw new InternalServerErrorException(evErr.message);
    }

    const { specContext: _omit, ...stored } = d;
    void _omit;
    const { error: snapErr } = await client.from('snapshots').insert({
      project_id: project.id,
      owner_id: user.id,
      total_stories: d.stats.totalStories ?? 0,
      done_stories: d.stats.byStatus?.done ?? 0,
      in_progress_stories: d.stats.byStatus?.['in-progress'] ?? 0,
      review_stories: d.stats.byStatus?.review ?? 0,
      tasks_total: d.stats.tasksTotal ?? 0,
      tasks_done: d.stats.tasksDone ?? 0,
      signature,
      dashboard: stored,
    });
    if (snapErr) throw new InternalServerErrorException(snapErr.message);
    return { project, snapshotCreated: true, events: events.length };
  }

  @Get(':id/history')
  async history(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client
      .from('snapshots')
      .select('id, created_at, total_stories, done_stories, in_progress_stories, review_stories, tasks_total, tasks_done')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(120);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).reverse();
  }

  /** Transiciones de estado de las historias (para las métricas). */
  @Get(':id/events')
  async events(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client
      .from('story_events')
      .select('story_id, story_title, epic, from_status, to_status, kind, occurred_at')
      .eq('project_id', id)
      .order('occurred_at', { ascending: true })
      .limit(5000);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  /** Registra el consumo de tokens de una petición al asistente. */
  @Post(':id/ai-usage')
  async addUsage(
    @Headers('authorization') auth: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: { task: string; provider: string; model?: string; usage?: any; docsMode?: string; docSections?: number; conversationId?: string | null },
  ) {
    const { client, user } = await this.supabase.user(auth);
    if (!['chat', 'draft-story', 'review-story'].includes(b?.task) || !['groq', 'claude'].includes(b?.provider)) throw new BadRequestException('Datos de uso no válidos.');
    const n = (v: unknown) => Math.max(0, Math.min(10_000_000, Math.round(Number(v) || 0)));
    const uuidRe = /^[0-9a-f-]{36}$/i;
    const { error } = await client.from('ai_usage').insert({
      project_id: id,
      owner_id: user.id,
      conversation_id: b.conversationId && uuidRe.test(b.conversationId) ? b.conversationId : null,
      task: b.task,
      provider: b.provider,
      model: b.model ? String(b.model).slice(0, 100) : null,
      input_tokens: n(b.usage?.input),
      output_tokens: n(b.usage?.output),
      cache_read_tokens: n(b.usage?.cacheRead),
      cache_write_tokens: n(b.usage?.cacheWrite),
      docs_mode: b.docsMode ? String(b.docsMode).slice(0, 20) : null,
      doc_sections: n(b.docSections),
      stop_reason: b.usage?.stopReason ? String(b.usage.stopReason).slice(0, 40) : null,
    });
    if (error) throw new InternalServerErrorException(error.message);
    return { ok: true };
  }

  /** Consumo de tokens del asistente en los últimos N días (máx. 180). */
  @Get(':id/ai-usage')
  async usage(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string, @Query('days') days?: string) {
    const { client } = await this.supabase.user(auth);
    const d = Math.min(180, Math.max(1, Number(days) || 30));
    const since = new Date(Date.now() - d * 86_400_000).toISOString();
    const { data, error } = await client
      .from('ai_usage')
      .select('task, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, docs_mode, doc_sections, stop_reason, created_at')
      .eq('project_id', id)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(10000);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  @Get(':id/latest')
  async latest(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client.from('snapshots').select('created_at, dashboard').eq('project_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Este proyecto aún no tiene snapshots.');
    return data;
  }

  @Delete(':id')
  async remove(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    const { client } = await this.supabase.user(auth);
    const { error } = await client.from('projects').delete().eq('id', id);
    if (error) throw new InternalServerErrorException(error.message);
    return { deleted: true };
  }

  @Get(':id/specs')
  async specs(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string) {
    const { client } = await this.supabase.user(auth);
    const { data, error } = await client
      .from('story_specs')
      .select('id, story_id, story_key, title, status, file_name, markdown, saved_to_disk, created_at')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  @Post(':id/specs')
  async addSpec(@Headers('authorization') auth: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: SpecRecordBody) {
    const { client, user } = await this.supabase.user(auth);
    if (!body?.storyId || !body?.title || !body?.markdown) throw new BadRequestException('Faltan datos de la especificación.');
    const { data, error } = await client
      .from('story_specs')
      .insert({
        project_id: id,
        owner_id: user.id,
        story_id: String(body.storyId).slice(0, 20),
        story_key: body.storyKey ? String(body.storyKey).slice(0, 200) : null,
        title: String(body.title).slice(0, 300),
        status: body.status ?? null,
        file_name: body.fileName ?? null,
        markdown: String(body.markdown).slice(0, 200000),
        quality: body.quality ?? null,
        saved_to_disk: !!body.savedToDisk,
      })
      .select('id, created_at')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }
}
