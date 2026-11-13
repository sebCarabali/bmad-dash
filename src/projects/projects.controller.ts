import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, InternalServerErrorException, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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

    const { data: last } = await client.from('snapshots').select('signature').eq('project_id', project.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last?.signature === signature) return { project, snapshotCreated: false };

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
    return { project, snapshotCreated: true };
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
