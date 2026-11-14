import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  Alert,
  Artifact,
  BmadVersion,
  CommandStyle,
  DashboardData,
  EpicStatus,
  EpicView,
  ParsedStory,
  PlannedEpic,
  RetroStatus,
  SpecContext,
  PlanningDoc,
  SprintStatusData,
  StoryView,
  VFile,
  emptyCounts,
  normalizeStoryStatus,
} from './types';
import { STORY_FILE_RE, looksLikeStory, parseStory } from './parsers/story.parser';
import { EPICS_FILE_RE, parseEpicsFile } from './parsers/epics.parser';
import { parseSprintStatus } from './parsers/sprint-status.parser';
import { humanizeSlug } from './parsers/markdown.util';
import { SuggestionEngine } from './suggestions';

const P = path.posix;

/** Carpetas que nunca contienen datos del proyecto BMAD. */
export const IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'bin', 'obj',
  '.idea', '.vscode', '.vs', 'coverage', 'vendor', 'packages', '.gradle', '__pycache__', '.venv', 'venv',
];
/** Instalación del método (plantillas, agentes): solo se lee su config. */
export const METHOD_DIRS = ['_bmad', '.bmad-core', '.bmad'];
/** Config del método, de lo general a lo específico (las últimas sobrescriben a las primeras). */
export const CONFIG_FILES = ['_bmad/core/config.yaml', '_bmad/bmm/config.yaml', 'bmad/core/config.yaml', 'bmad/bmm/config.yaml', '.bmad-core/core-config.yaml'];
export const MAX_FILE_SIZE = 1024 * 1024;

/** ¿Hace falta el contenido de este archivo para el análisis? (el resto basta con nombre y fecha) */
export function needsContent(relPath: string): boolean {
  const name = P.basename(relPath);
  if (CONFIG_FILES.includes(relPath)) return true;
  if (/^sprint-status\.ya?ml$/i.test(name)) return true;
  if (STORY_FILE_RE.test(name) && !/context|tech-spec|retro/i.test(name)) return true;
  if (EPICS_FILE_RE.test(name) && !/tech-spec|retro|context/i.test(name)) return true;
  return false;
}

export interface AnalyzeInput {
  /** Etiqueta de la raíz: ruta absoluta (modo local) o nombre de la carpeta (navegador). */
  root: string;
  source: 'local' | 'browser';
  files: VFile[];
  /** Entradas de primer nivel de la raíz + marcadores como "bmad/bmm". */
  markers: string[];
}

export interface ScanContext {
  root: string;
  source: 'local' | 'browser';
  files: VFile[];
  version: BmadVersion;
  config: Record<string, string>;
  sprint?: SprintStatusData;
  sprintContent?: string;
  parsedStories: ParsedStory[];
  plannedEpics: PlannedEpic[];
  storiesDir: string; // relativo a la raíz, formato posix
  alerts: Alert[];
}

export function detectVersion(markers: string[], files: VFile[]): BmadVersion {
  const has = (m: string) => markers.includes(m);
  if (has('_bmad') || has('_bmad-output')) return 'v6';
  if (has('bmad/bmm')) return 'v6-alpha';
  if (has('.bmad-core')) return 'v4';
  if (has('bmad')) return 'v6-alpha';
  if (files.some((f) => /^sprint-status\.ya?ml$/i.test(P.basename(f.path)))) return 'v6-alpha';
  if (files.some((f) => f.path.startsWith('docs/stories/'))) return 'v4';
  return 'unknown';
}

export function buildScanContext(input: AnalyzeInput): ScanContext {
  const files = input.files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.\//, '') }));
  const alerts: Alert[] = [];
  const version = detectVersion(input.markers, files);
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Configuración del método
  let config: Record<string, string> = {};
  const used: string[] = [];
  for (const c of CONFIG_FILES) {
    const f = byPath.get(c);
    if (!f?.content) continue;
    try {
      const doc: any = yaml.load(f.content) ?? {};
      used.push(c);
      for (const [k, v] of Object.entries(doc)) {
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) config[k] = v.join(', ');
        else if (v !== null && typeof v !== 'object' && String(v).trim() !== '') config[k] = String(v).trim();
      }
      config._file = used.join(', ');
    } catch {
      alerts.push({ level: 'warning', message: `No se pudo leer ${c}` });
    }
  }

  // sprint-status.yaml (el más reciente)
  const sprintFiles = files.filter((f) => /^sprint-status\.ya?ml$/i.test(P.basename(f.path)) && f.content !== undefined).sort((a, b) => b.mtime - a.mtime);
  let sprint: SprintStatusData | undefined;
  let sprintContent: string | undefined;
  if (sprintFiles.length) {
    const f = sprintFiles[0];
    try {
      sprint = parseSprintStatus(f.content, f.path, f.mtime);
      sprintContent = f.content;
    } catch (e) {
      alerts.push({ level: 'error', message: (e as Error).message });
    }
    if (sprintFiles.length > 1) alerts.push({ level: 'info', message: `Se encontraron ${sprintFiles.length} sprint-status.yaml; se usa el más reciente: ${f.path}` });
  }

  // Historias
  const parsed: ParsedStory[] = [];
  for (const f of files) {
    const name = P.basename(f.path);
    if (!f.content || !STORY_FILE_RE.test(name) || /context|tech-spec|retro/i.test(name)) continue;
    if (!looksLikeStory(f.content)) continue;
    const s = parseStory(name, f.content, f.path, f.mtime);
    if (s) parsed.push(s);
  }
  const byId = new Map<string, ParsedStory>();
  for (const s of parsed.sort((a, b) => b.mtime - a.mtime)) {
    if (byId.has(s.id)) {
      alerts.push({ level: 'warning', storyId: s.id, message: `La historia ${s.id} existe en varios archivos: ${byId.get(s.id).relativePath} y ${s.relativePath}` });
      continue;
    }
    byId.set(s.id, s);
  }

  // Épicas planificadas
  const plannedEpics: PlannedEpic[] = [];
  for (const f of files) {
    const name = P.basename(f.path);
    if (!f.content || !EPICS_FILE_RE.test(name) || /tech-spec|retro|context/i.test(name)) continue;
    for (const e of parseEpicsFile(f.content, f.path)) {
      const existing = plannedEpics.find((x) => x.number === e.number);
      if (!existing) plannedEpics.push(e);
      else {
        if (existing.title.startsWith('Epic ') && !e.title.startsWith('Epic ')) existing.title = e.title;
        if (!existing.description && e.description) existing.description = e.description;
        for (const s of e.stories) if (!existing.stories.some((x) => x.id === s.id)) existing.stories.push(s);
      }
    }
  }

  const parsedStories = [...byId.values()];
  const storiesDir = resolveStoriesDir(input, sprint, parsedStories, config, version);
  return { root: input.root, source: input.source, files, version, config, sprint, sprintContent, parsedStories, plannedEpics, storiesDir, alerts };
}

function resolveStoriesDir(input: AnalyzeInput, sprint: SprintStatusData | undefined, stories: ParsedStory[], config: Record<string, string>, version: BmadVersion): string {
  const outputFolder = expand(config.output_folder ?? 'docs', input.root, 'docs');
  const tryExpand = (v?: string) => (v ? expand(v, input.root, outputFolder) : undefined);
  const fromSprint = tryExpand(sprint?.storyLocation);
  if (fromSprint !== undefined) return fromSprint;
  if (stories.length) {
    const counts = new Map<string, number>();
    for (const s of stories) {
      const d = P.dirname(s.relativePath);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  for (const key of ['implementation_artifacts', 'sprint_artifacts', 'devStoryLocation', 'dev_story_location']) {
    const v = tryExpand(config[key]);
    if (v !== undefined) return v;
  }
  if (sprint) return P.dirname(sprint.relativePath);
  if (version === 'v6') return '_bmad-output/implementation-artifacts';
  return 'docs/stories';
}

/** Convierte "{project-root}/docs/x" o rutas absolutas dentro de la raíz en una ruta relativa posix. */
function expand(value: string, root: string, outputFolder: string): string | undefined {
  let v = value.trim().replace(/\\/g, '/');
  v = v.replace(/\{output_folder\}/g, outputFolder);
  v = v.replace(/^\{project-root\}\/?/, '');
  if (/\{[^}]+\}/.test(v)) return undefined;
  const rootPosix = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (/^([a-zA-Z]:)?\//.test(v)) {
    if (rootPosix && v.toLowerCase().startsWith(rootPosix.toLowerCase() + '/')) v = v.slice(rootPosix.length + 1);
    else return undefined;
  }
  const n = P.normalize(v || '.').replace(/\/$/, '');
  if (n.startsWith('..')) return undefined;
  return n === '' ? '.' : n;
}

// ---------------------------------------------------------------------------

export function buildDashboard(ctx: ScanContext, style?: CommandStyle): DashboardData {
  const { sprint, parsedStories, plannedEpics } = ctx;
  const alerts = [...ctx.alerts];

  const views = new Map<string, StoryView>();
  const ensure = (epic: number, number: number): StoryView => {
    const id = `${epic}.${number}`;
    if (!views.has(id)) {
      views.set(id, {
        id, epic, number, key: `${epic}-${number}`, title: `Historia ${id}`, status: 'backlog',
        hasFile: false, planned: false, tasksTotal: 0, tasksDone: 0, acCount: 0, pendingReviewItems: 0, warnings: [],
      });
    }
    return views.get(id);
  };

  for (const e of plannedEpics)
    for (const p of e.stories) {
      const v = ensure(p.epic, p.number);
      v.planned = true;
      v.title = p.title;
      v.acCount = p.acceptanceCriteria.length;
    }

  if (sprint)
    for (const s of sprint.stories) {
      const v = ensure(s.epic, s.number);
      v.key = s.key;
      v.sprintStatus = s.status;
      if (v.title.startsWith('Historia ') && s.slug) v.title = humanizeSlug(s.slug);
    }

  for (const p of parsedStories) {
    const v = ensure(p.epic, p.number);
    v.hasFile = true;
    v.title = p.title || v.title;
    v.fileStatus = p.rawStatus;
    v.relativePath = p.relativePath;
    v.mtime = p.mtime;
    v.tasksTotal = p.tasksTotal;
    v.tasksDone = p.tasksDone;
    v.acCount = p.acceptanceCriteria.length || v.acCount;
    v.reviewOutcome = p.reviewOutcome;
    v.pendingReviewItems = p.pendingReviewItems;
    if (!sprint || !sprint.stories.some((s) => s.epic === p.epic && s.number === p.number)) {
      v.key = p.slug ? `${p.epic}-${p.number}-${p.slug}` : v.key;
    }
  }

  for (const v of views.values()) {
    const fromSprint = normalizeStoryStatus(v.sprintStatus);
    const fromFile = normalizeStoryStatus(v.fileStatus);
    if (v.sprintStatus && !fromSprint) v.warnings.push(`Estado desconocido en sprint-status: "${v.sprintStatus}"`);
    if (v.fileStatus && !fromFile) v.warnings.push(`Estado desconocido en el archivo: "${v.fileStatus}"`);
    v.status = fromSprint ?? fromFile ?? (v.hasFile ? 'drafted' : 'backlog');
    if (fromSprint && fromFile && fromSprint !== fromFile) v.warnings.push(`Estado desincronizado: sprint-status dice "${fromSprint}" y el archivo dice "${fromFile}"`);
    if (sprint && !v.sprintStatus && v.hasFile) v.warnings.push('La historia tiene archivo pero no aparece en sprint-status.yaml');
    if (!v.hasFile && ['drafted', 'ready-for-dev', 'in-progress', 'review', 'done'].includes(v.status)) v.warnings.push(`Marcada como "${v.status}" pero no se encontró su archivo .md`);
    if (v.status === 'done' && v.tasksTotal > 0 && v.tasksDone < v.tasksTotal) v.warnings.push(`Marcada como done con ${v.tasksTotal - v.tasksDone} tarea(s) sin completar`);
    if (v.status === 'review' && v.tasksTotal > 0 && v.tasksDone < v.tasksTotal) v.warnings.push(`En revisión con ${v.tasksTotal - v.tasksDone} tarea(s) sin marcar`);
    if (['ready-for-dev', 'in-progress'].includes(v.status) && v.hasFile && v.acCount === 0) v.warnings.push('La historia no tiene criterios de aceptación');
    for (const w of v.warnings)
      alerts.push({ level: w.startsWith('Estado desincronizado') || w.includes('sin completar') ? 'warning' : 'info', message: `${v.id}: ${w}`, storyId: v.id });
  }

  const stories = [...views.values()].sort((a, b) => a.epic - b.epic || a.number - b.number);

  const epicNumbers = new Set<number>([...plannedEpics.map((e) => e.number), ...Object.keys(sprint?.epics ?? {}).map(Number), ...stories.map((s) => s.epic)]);
  const epics: EpicView[] = [...epicNumbers].sort((a, b) => a - b).map((n) => {
    const planned = plannedEpics.find((e) => e.number === n);
    const st = stories.filter((s) => s.epic === n);
    const counts = emptyCounts();
    st.forEach((s) => counts[s.status]++);
    const declared = sprint?.epics[n];
    const derived: EpicStatus = st.length > 0 && counts.done === st.length ? 'done' : st.some((s) => s.status !== 'backlog') ? 'in-progress' : 'backlog';
    const declaredNorm = (declared ?? '').toLowerCase() as EpicStatus;
    const status: EpicStatus = ['backlog', 'contexted', 'in-progress', 'done'].includes(declaredNorm) ? declaredNorm : derived;
    const retroRaw = (sprint?.retrospectives[n] ?? '').toLowerCase();
    const retrospective: RetroStatus = retroRaw === 'completed' || retroRaw === 'done' ? 'completed' : retroRaw ? 'optional' : 'none';
    const warnings: string[] = [];
    if (declared && status === 'done' && derived !== 'done') warnings.push('La épica está marcada como done pero tiene historias sin terminar');
    if (derived === 'done' && status !== 'done') warnings.push('Todas las historias están terminadas: marca la épica como done');
    if (st.length === 0) warnings.push('La épica no tiene historias definidas');
    warnings.forEach((w) => alerts.push({ level: 'info', epic: n, message: `Épica ${n}: ${w}` }));
    return {
      number: n,
      title: planned?.title ?? `Epic ${n}`,
      description: planned?.goal ?? planned?.description?.slice(0, 600) ?? '',
      status,
      declaredStatus: declared,
      retrospective,
      stories: st,
      counts,
      progress: st.length ? Math.round((counts.done / st.length) * 100) : 0,
      warnings,
    };
  });

  const byStatus = emptyCounts();
  stories.forEach((s) => byStatus[s.status]++);
  const stats = {
    totalStories: stories.length,
    byStatus,
    donePercent: stories.length ? Math.round((byStatus.done / stories.length) * 100) : 0,
    tasksTotal: stories.reduce((a, s) => a + s.tasksTotal, 0),
    tasksDone: stories.reduce((a, s) => a + s.tasksDone, 0),
    epicsTotal: epics.length,
    epicsDone: epics.filter((e) => e.status === 'done').length,
  };

  const commandStyle: CommandStyle = style ?? (ctx.version === 'v4' ? 'v4' : 'v6-slash');
  if (!sprint && ctx.version !== 'v4') alerts.push({ level: 'warning', message: 'No se encontró sprint-status.yaml. Ejecuta sprint-planning para generarlo.' });
  if (stories.length === 0) alerts.push({ level: 'info', message: 'No se encontraron historias en el proyecto.' });

  const details: Record<string, ParsedStory> = {};
  for (const p of parsedStories) details[p.id] = p;

  return {
    root: ctx.root,
    source: ctx.source,
    projectName: sprint?.project ?? ctx.config.project_name ?? (P.basename(ctx.root.replace(/\\/g, '/')) || ctx.root),
    version: ctx.version,
    commandStyle,
    sprintStatusFile: sprint?.relativePath,
    storiesDirRelative: ctx.storiesDir,
    scannedFiles: ctx.files.length,
    generatedAt: new Date().toISOString(),
    stats,
    epics,
    stories,
    suggestions: new SuggestionEngine().build({ stories, epics, hasSprintStatus: !!sprint, version: ctx.version, plannedEpics: plannedEpics.length }, commandStyle),
    alerts: dedupeAlerts(alerts),
    artifacts: findArtifacts(ctx.files),
    activity: activity(ctx),
    config: ctx.config,
    details,
    specContext: toSpecContext(ctx),
    planningDocs: findPlanningDocs(ctx.files, ctx.config),
  };
}

/**
 * Documentos de planificación que el asistente puede usar como contexto.
 * Si un documento está fragmentado (p. ej. docs/architecture/*.md, de shard-doc), se usan los fragmentos.
 */
export function findPlanningDocs(files: VFile[], config: Record<string, string>): PlanningDoc[] {
  const kindOf = (p: string): PlanningDoc['kind'] | null => {
    const name = P.basename(p).toLowerCase();
    const dirs = p.toLowerCase().split('/').slice(0, -1);
    if (/^project[-_]context\.md$/.test(name)) return 'context';
    if (STORY_FILE_RE.test(P.basename(p)) || /sprint-status|retro|tech-spec|readiness|checklist/.test(name)) return null;
    if (name === 'index.md' && dirs.some((d) => ['prd', 'architecture', 'epics'].includes(d) || /^ux([-_].*)?$/.test(d))) return null; // índice de shard-doc
    if (dirs.includes('prd')) return 'prd';
    if (dirs.includes('architecture')) return 'architecture';
    if (dirs.some((d) => /^ux([-_].*)?$/.test(d))) return 'ux';
    if (/^prd(\.md|[-_].*\.md)$/.test(name)) return 'prd';
    if (/^architecture.*\.md$/.test(name)) return 'architecture';
    if (/^(ux[-_].*|.*ux[-_]?(design|spec).*)\.md$/.test(name)) return 'ux';
    if (/^(product[-_]?brief).*\.md$/.test(name)) return 'brief';
    if (/^epics?\.md$/.test(name) || dirs.includes('epics')) return 'epics';
    return null;
  };
  const always = new Set(
    (config.devLoadAlwaysFiles ?? config.dev_load_always_files ?? '')
      .split(',')
      .map((x) => x.trim().replace(/^\.\//, ''))
      .filter(Boolean),
  );
  const out: PlanningDoc[] = [];
  for (const f of files) {
    if (!/\.md$/i.test(f.path) || CONFIG_FILES.includes(f.path)) continue;
    const kind = always.has(f.path) ? 'always' : kindOf(f.path);
    if (kind) out.push({ path: f.path, kind, mtime: f.mtime, size: f.size, shard: kind !== 'always' && kind !== 'context' && P.basename(f.path).toLowerCase() !== `${kind}.md` && f.path.toLowerCase().split('/').slice(0, -1).includes(kind) });
  }
  // Si hay fragmentos de un tipo, se omite el documento completo de ese tipo (evita duplicados)
  const sharded = new Set(out.filter((d) => d.shard).map((d) => d.kind));
  return out.filter((d) => d.shard || !sharded.has(d.kind)).sort((a, b) => a.path.localeCompare(b.path));
}

export function nextStoryNumber(ctx: { parsedStories: ParsedStory[]; sprint?: SprintStatusData; plannedEpics: PlannedEpic[] }, epic: number): number {
  const nums = [
    ...ctx.parsedStories.filter((s) => s.epic === epic).map((s) => s.number),
    ...(ctx.sprint?.stories ?? []).filter((s) => s.epic === epic).map((s) => s.number),
    ...ctx.plannedEpics.filter((e) => e.number === epic).flatMap((e) => e.stories.map((s) => s.number)),
  ];
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export function toSpecContext(ctx: ScanContext): SpecContext {
  const withFile = new Set(ctx.parsedStories.map((s) => s.id));
  const epicNumbers = new Set<number>([...ctx.plannedEpics.map((e) => e.number), ...Object.keys(ctx.sprint?.epics ?? {}).map(Number), ...ctx.parsedStories.map((s) => s.epic)]);
  return {
    version: ctx.version,
    storiesDir: ctx.storiesDir,
    hasSprintStatus: !!ctx.sprint,
    sprintStatusFile: ctx.sprint?.relativePath,
    author: ctx.config.user_name ?? '',
    sprintStories: (ctx.sprint?.stories ?? []).map((s) => ({ epic: s.epic, number: s.number, key: s.key, slug: s.slug })),
    sprintEpics: Object.keys(ctx.sprint?.epics ?? {}).map(Number),
    fileStories: ctx.parsedStories.map((s) => ({ epic: s.epic, number: s.number, relativePath: s.relativePath })),
    plannedEpics: [...epicNumbers]
      .sort((a, b) => a - b)
      .map((n) => {
        const pe = ctx.plannedEpics.find((e) => e.number === n);
        return {
          number: n,
          title: pe?.title ?? `Epic ${n}`,
          sourceFile: pe?.sourceFile ?? '',
          nextNumber: nextStoryNumber(ctx, n),
          plannedStories: (pe?.stories ?? []).filter((s) => !withFile.has(s.id)),
        };
      }),
  };
}

function findArtifacts(files: VFile[]): Artifact[] {
  const rules: [RegExp, string, string][] = [
    [/^(product[-_]?brief).*\.md$/i, 'brief', 'Product Brief'],
    [/^prd(\.md|[-_].*\.md)$/i, 'prd', 'PRD'],
    [/^(ux[-_].*|.*ux[-_]?(design|spec).*)\.md$/i, 'ux', 'Diseño UX'],
    [/^architecture.*\.md$/i, 'architecture', 'Arquitectura'],
    [/^epics?\.md$/i, 'epics', 'Épicas'],
    [/^tech[-_]?spec.*\.md$/i, 'tech-spec', 'Tech Spec'],
    [/^project[-_]context\.md$/i, 'context', 'Project Context'],
    [/^bmm-workflow-status\.ya?ml$/i, 'workflow-status', 'Workflow Status'],
    [/^sprint-status\.ya?ml$/i, 'sprint-status', 'Sprint Status'],
    [/^(implementation-readiness|.*readiness).*\.md$/i, 'readiness', 'Implementation Readiness'],
    [/retro(spective)?.*\.md$/i, 'retro', 'Retrospectiva'],
  ];
  const out: Artifact[] = [];
  for (const f of files) {
    if (CONFIG_FILES.includes(f.path)) continue;
    const name = P.basename(f.path);
    const r = rules.find(([re]) => re.test(name));
    if (r) out.push({ type: r[1], label: r[2], relativePath: f.path, mtime: f.mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
}

function activity(ctx: ScanContext) {
  const items: { relativePath: string; label: string; mtime: number; storyId?: string }[] = ctx.parsedStories.map((p) => ({
    relativePath: p.relativePath,
    label: `Historia ${p.id}: ${p.title}`,
    mtime: p.mtime,
    storyId: p.id,
  }));
  if (ctx.sprint) items.push({ relativePath: ctx.sprint.relativePath, label: 'sprint-status.yaml actualizado', mtime: ctx.sprint.mtime });
  return items.sort((a, b) => b.mtime - a.mtime).slice(0, 12);
}

function dedupeAlerts(alerts: Alert[]): Alert[] {
  const seen = new Set<string>();
  const order = { error: 0, warning: 1, info: 2 };
  return alerts.filter((a) => (seen.has(a.message) ? false : (seen.add(a.message), true))).sort((a, b) => order[a.level] - order[b.level]);
}
