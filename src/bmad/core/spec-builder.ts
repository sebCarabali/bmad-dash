import * as path from 'path';
import { SpecContext } from './types';
import { slugify } from './parsers/markdown.util';
import { insertStoryInSprintStatus } from './parsers/sprint-status.parser';

const P = path.posix;

export interface StorySpecInput {
  epic: number;
  number?: number;
  title: string;
  role?: string;
  want?: string;
  benefit?: string;
  acceptanceCriteria?: string[] | string;
  tasks?: string;
  devNotes?: string;
  references?: string[] | string;
  status?: 'backlog' | 'drafted' | 'ready-for-dev';
  template?: 'v6' | 'v4';
  author?: string;
  overwrite?: boolean;
}

export interface QualityCheck {
  level: 'ok' | 'warning' | 'error';
  message: string;
}

export interface SpecResult {
  epic: number;
  number: number;
  storyId: string;
  storyKey: string;
  fileName: string;
  relativeTarget: string;
  template: 'v6' | 'v4';
  status: string;
  markdown: string;
  quality: QualityCheck[];
  prompt: string;
  /** Contenido nuevo de sprint-status.yaml (si se envió el original). */
  sprintStatusContent?: string;
  sprintStatusChanged?: boolean;
}

const V4_STATUS: Record<string, string> = { backlog: 'Draft', drafted: 'Draft', 'ready-for-dev': 'Approved' };

export function validateSpecInput(dto: StorySpecInput): string | null {
  if (!dto) return 'Faltan los datos de la historia.';
  if (!dto.title || !String(dto.title).trim()) return 'La historia necesita un título.';
  if (!Number.isInteger(Number(dto.epic)) || Number(dto.epic) < 1) return 'Selecciona una épica válida.';
  if (dto.number !== undefined && dto.number !== null && (!Number.isInteger(Number(dto.number)) || Number(dto.number) < 1)) return 'Número de historia inválido.';
  return null;
}

export function buildSpec(dto: StorySpecInput, ctx: SpecContext, sprintStatusContent?: string): SpecResult {
  const epic = Number(dto.epic);
  const epicInfo = ctx.plannedEpics.find((e) => e.number === epic);
  const number = dto.number ? Number(dto.number) : (epicInfo?.nextNumber ?? 1);
  const title = String(dto.title).trim();
  const slug = slugify(title) || 'story';
  const template = dto.template ?? (ctx.version === 'v4' ? 'v4' : 'v6');
  const status = dto.status ?? 'drafted';
  const acs = toList(dto.acceptanceCriteria);
  const refs = toList(dto.references);
  const tasks = parseTasks(dto.tasks ?? '', acs.length);
  const today = new Date().toISOString().slice(0, 10);
  const role = (dto.role ?? '').trim() || 'usuario';
  const want = (dto.want ?? '').trim() || '…';
  const benefit = (dto.benefit ?? '').trim().replace(/\.$/, '') || '…';

  if (epicInfo?.sourceFile && !refs.some((r) => r.includes(epicInfo.sourceFile))) refs.unshift(`[Source: ${epicInfo.sourceFile}#Epic-${epic}]`);

  // Si sprint-status ya tiene la historia (p. ej. en backlog), se respeta su clave
  const sprintEntry = ctx.sprintStories.find((s) => s.epic === epic && s.number === number);
  const storyKey = sprintEntry ? sprintEntry.key : `${epic}-${number}-${slug}`;
  const fileSlug = sprintEntry?.slug || slug;
  const fileName = template === 'v4' ? `${epic}.${number}.${fileSlug}.md` : `${storyKey}.md`;

  const acBlock = acs.length ? acs.map((a, i) => `${i + 1}. ${a}`).join('\n') : '1. (Define los criterios de aceptación)';
  const taskBlock = tasks.length
    ? tasks.map((t) => `- [ ] ${t.text}${t.acs ? ` (AC: ${t.acs})` : ''}\n${t.subtasks.map((s) => `  - [ ] ${s}`).join('\n')}`.trimEnd()).join('\n')
    : '- [ ] Tarea 1 (AC: #1)\n  - [ ] Subtarea 1.1';
  const refsBlock = refs.length ? refs.map((r) => `- ${r}`).join('\n') : '- (Agrega referencias a PRD / arquitectura)';
  const notes = (dto.devNotes ?? '').trim() || '- (Notas técnicas, restricciones de arquitectura, patrones a seguir, consideraciones de pruebas)';
  const author = (dto.author ?? '').trim() || ctx.author || 'BMAD Dashboard';
  const changeLog = `| Date | Version | Description | Author |\n| ---- | ------- | ----------- | ------ |\n| ${today} | 0.1 | Borrador inicial generado con BMAD Dashboard | ${author} |`;

  const markdown =
    template === 'v4'
      ? `# Story ${epic}.${number}: ${title}

## Status

${V4_STATUS[status] ?? 'Draft'}

## Story

**As a** ${role},
**I want** ${want},
**so that** ${benefit}

## Acceptance Criteria

${acBlock}

## Tasks / Subtasks

${taskBlock}

## Dev Notes

${notes}

### Testing

- (Estándares y ubicación de pruebas según la arquitectura)

### References

${refsBlock}

## Change Log

${changeLog}

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## QA Results
`
      : `# Story ${epic}.${number}: ${title}

Status: ${status}

## Story

As a ${role},
I want ${want},
so that ${benefit}.

## Acceptance Criteria

${acBlock}

## Tasks / Subtasks

${taskBlock}

## Dev Notes

${notes}

### Project Structure Notes

- (Ubicación de archivos y módulos según la arquitectura)

### References

${refsBlock}

## Dev Agent Record

### Context Reference

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log

${changeLog}
`;

  const relativeTarget = P.normalize(P.join(ctx.storiesDir || '.', fileName));
  const prompt = [
    `Crea/refina la historia ${epic}.${number} "${title}" de la Épica ${epic}${epicInfo && !epicInfo.title.startsWith('Epic ') ? ` (${epicInfo.title})` : ''}.`,
    `Ya existe un borrador en ${relativeTarget}. Úsalo como punto de partida:`,
    `- Verifica los criterios de aceptación contra el PRD y la arquitectura y complétalos si falta algo.`,
    `- Desglosa las tareas en subtareas técnicas concretas, vinculadas a cada AC.`,
    `- Completa Dev Notes con el contexto de arquitectura relevante (patrones, rutas de archivos, pruebas).`,
    `- No cambies el alcance de la historia sin avisarme.`,
  ].join('\n');

  const result: SpecResult = {
    epic, number, storyId: `${epic}.${number}`, storyKey, fileName, relativeTarget, template, status, markdown,
    quality: quality(dto, acs, tasks, ctx, epic, number),
    prompt,
  };
  if (sprintStatusContent !== undefined) {
    const updated = insertStoryInSprintStatus(sprintStatusContent, epic, storyKey, status);
    result.sprintStatusContent = updated;
    result.sprintStatusChanged = updated !== sprintStatusContent;
  }
  return result;
}

interface ParsedTask {
  text: string;
  acs?: string;
  subtasks: string[];
}

function quality(dto: StorySpecInput, acs: string[], tasks: ParsedTask[], ctx: SpecContext, epic: number, number: number): QualityCheck[] {
  const q: QualityCheck[] = [];
  const exists = ctx.fileStories.find((s) => s.epic === epic && s.number === number);
  if (exists) q.push({ level: dto.overwrite ? 'warning' : 'error', message: `Ya existe la historia ${epic}.${number} en ${exists.relativePath}.` });
  if (!dto.role || !dto.want || !dto.benefit) q.push({ level: 'warning', message: 'Completa el formato "As a / I want / so that".' });
  else q.push({ level: 'ok', message: 'User story con rol, necesidad y beneficio.' });
  if (acs.length === 0) q.push({ level: 'error', message: 'Agrega al menos un criterio de aceptación.' });
  else if (acs.length > 8) q.push({ level: 'warning', message: `${acs.length} criterios de aceptación: considera dividir la historia.` });
  else q.push({ level: 'ok', message: `${acs.length} criterio(s) de aceptación.` });
  const vague = acs.filter((a) => /\b(r[aá]pido|f[aá]cil|intuitiv\w*|amigable|bien|adecuad\w*|fast|easy|user[- ]friendly|etc)\b/i.test(a));
  if (vague.length) q.push({ level: 'warning', message: `Criterios poco verificables (${vague.length}): usa valores medibles o Given/When/Then.` });
  if (tasks.length === 0) q.push({ level: 'warning', message: 'Sin tareas: el agente dev las inferirá, pero es mejor definirlas.' });
  else {
    if (tasks.length > 10) q.push({ level: 'warning', message: `${tasks.length} tareas: la historia puede ser demasiado grande para una sesión.` });
    const covered = new Set(tasks.flatMap((t) => (t.acs ?? '').split(/[,\s#]+/).filter(Boolean)));
    const uncovered = acs.map((_, i) => String(i + 1)).filter((n) => !covered.has(n));
    if (acs.length && uncovered.length) q.push({ level: 'warning', message: `AC sin tarea asociada: ${uncovered.map((n) => '#' + n).join(', ')}. Agrega "(AC: n)" al final de la tarea.` });
    else if (acs.length) q.push({ level: 'ok', message: 'Todos los AC están cubiertos por alguna tarea.' });
  }
  if (String(dto.title).length > 80) q.push({ level: 'warning', message: 'Título largo: resúmelo en menos de 80 caracteres.' });
  const epicKnown = ctx.plannedEpics.some((e) => e.number === epic && (e.sourceFile || ctx.sprintEpics.includes(epic))) || ctx.sprintEpics.includes(epic);
  if (!epicKnown) q.push({ level: 'warning', message: `La Épica ${epic} no existe todavía en epics.md ni en sprint-status.yaml.` });
  if (!ctx.hasSprintStatus) q.push({ level: 'warning', message: 'No hay sprint-status.yaml: la historia no quedará registrada en el seguimiento.' });
  return q;
}

function toList(v: string[] | string | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split('\n');
  return arr.map((s) => String(s).replace(/^\s*(\d+[.)]|[-*+])\s*/, '').trim()).filter(Boolean);
}

/**
 * Texto libre → tareas. Líneas sin sangría = tarea; con sangría o "-" = subtarea.
 * "(AC: 1, 2)" al final de la línea vincula criterios.
 */
function parseTasks(text: string, acCount: number): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const isSub = /^(\s{2,}|\t|\s*[-*+]\s)/.test(raw);
    let line = raw.trim().replace(/^[-*+]\s*/, '').replace(/^\[[ xX]\]\s*/, '').replace(/^\d+[.)]\s*/, '');
    let acs: string | undefined;
    const m = /\(\s*AC\s*:?\s*([#\d,\s]+)\)\s*$/i.exec(line);
    if (m) {
      acs = m[1].replace(/#/g, '').replace(/\s+/g, '').replace(/,/g, ', ');
      line = line.slice(0, m.index).trim();
    }
    if (isSub && tasks.length) tasks[tasks.length - 1].subtasks.push(line);
    else tasks.push({ text: line, acs, subtasks: [] });
  }
  if (acCount > 0 && tasks.length > 0 && tasks.every((t) => !t.acs) && tasks.length === acCount) tasks.forEach((t, i) => (t.acs = String(i + 1)));
  return tasks;
}
