export type StoryStatus = 'backlog' | 'drafted' | 'ready-for-dev' | 'in-progress' | 'review' | 'done';
export const STORY_STATUSES: StoryStatus[] = ['backlog', 'drafted', 'ready-for-dev', 'in-progress', 'review', 'done'];

export type EpicStatus = 'backlog' | 'contexted' | 'in-progress' | 'done';
export type RetroStatus = 'optional' | 'completed' | 'none';

export type BmadVersion = 'v6' | 'v6-alpha' | 'v4' | 'unknown';
export type CommandStyle = 'v6-slash' | 'v6-agent' | 'v6-dash' | 'v4';

export interface TaskItem {
  text: string;
  done: boolean;
  level: number;
  reviewFollowUp: boolean;
}

export interface ParsedStory {
  epic: number;
  number: number;
  id: string;
  slug?: string;
  title: string;
  rawStatus?: string;
  status?: StoryStatus;
  userStory?: string;
  acceptanceCriteria: string[];
  tasks: TaskItem[];
  tasksTotal: number;
  tasksDone: number;
  reviewOutcome?: string;
  pendingReviewItems: number;
  fileList: string[];
  changeLogCount: number;
  relativePath: string;
  mtime: number;
}

export interface PlannedStory {
  epic: number;
  number: number;
  id: string;
  title: string;
  userStory?: string;
  acceptanceCriteria: string[];
  body: string;
}

export interface PlannedEpic {
  number: number;
  title: string;
  description: string;
  goal?: string;
  stories: PlannedStory[];
  sourceFile: string;
}

export interface SprintStatusData {
  relativePath: string;
  mtime: number;
  project?: string;
  projectKey?: string;
  storyLocation?: string;
  epics: Record<number, string>;
  retrospectives: Record<number, string>;
  stories: { key: string; epic: number; number: number; slug: string; status: string }[];
}

export interface StoryView {
  id: string;
  epic: number;
  number: number;
  key: string;
  title: string;
  status: StoryStatus;
  sprintStatus?: string;
  fileStatus?: string;
  hasFile: boolean;
  planned: boolean;
  relativePath?: string;
  mtime?: number;
  tasksTotal: number;
  tasksDone: number;
  acCount: number;
  reviewOutcome?: string;
  pendingReviewItems: number;
  warnings: string[];
}

export interface EpicView {
  number: number;
  title: string;
  description: string;
  status: EpicStatus;
  declaredStatus?: string;
  retrospective: RetroStatus;
  stories: StoryView[];
  counts: Record<StoryStatus, number>;
  progress: number;
  warnings: string[];
}

export interface CommandSuggestion {
  priority: 'alta' | 'media' | 'baja';
  workflow: string;
  title: string;
  reason: string;
  agent?: string;
  steps: string[];
  argument?: string;
  storyId?: string;
  epic?: number;
  tip?: string;
}

export interface Artifact {
  type: string;
  label: string;
  relativePath: string;
  mtime: number;
}

export interface Alert {
  level: 'error' | 'warning' | 'info';
  message: string;
  storyId?: string;
  epic?: number;
}

export interface DashboardData {
  root: string;
  source: 'local' | 'browser';
  projectName: string;
  version: BmadVersion;
  commandStyle: CommandStyle;
  sprintStatusFile?: string;
  storiesDirRelative: string;
  scannedFiles: number;
  generatedAt: string;
  stats: {
    totalStories: number;
    byStatus: Record<StoryStatus, number>;
    donePercent: number;
    tasksTotal: number;
    tasksDone: number;
    epicsTotal: number;
    epicsDone: number;
  };
  epics: EpicView[];
  stories: StoryView[];
  suggestions: CommandSuggestion[];
  alerts: Alert[];
  artifacts: Artifact[];
  activity: { relativePath: string; label: string; mtime: number; storyId?: string }[];
  config: Record<string, string>;
  details: Record<string, ParsedStory>;
  specContext: SpecContext;
  planningDocs: PlanningDoc[];
}

/** Documento de planificación disponible como contexto para el asistente. */
export interface PlanningDoc {
  path: string;
  kind: 'prd' | 'architecture' | 'ux' | 'epics' | 'brief' | 'context' | 'always';
  mtime: number;
  size: number;
  shard: boolean;
}

/** Datos mínimos que necesita el generador de especificaciones. */
export interface SpecContext {
  version: BmadVersion;
  storiesDir: string;
  hasSprintStatus: boolean;
  sprintStatusFile?: string;
  author: string;
  sprintStories: { epic: number; number: number; key: string; slug: string }[];
  sprintEpics: number[];
  fileStories: { epic: number; number: number; relativePath: string }[];
  plannedEpics: { number: number; title: string; sourceFile: string; nextNumber: number; plannedStories: PlannedStory[] }[];
}

/** Archivo virtual: lo envía el navegador o lo lee el servidor en modo local. */
export interface VFile {
  path: string;
  mtime: number;
  size: number;
  content?: string;
}

const STATUS_MAP: Record<string, StoryStatus> = {
  backlog: 'backlog',
  todo: 'backlog',
  'to-do': 'backlog',
  pending: 'backlog',
  draft: 'drafted',
  drafted: 'drafted',
  approved: 'ready-for-dev',
  ready: 'ready-for-dev',
  'ready-for-dev': 'ready-for-dev',
  'ready-for-development': 'ready-for-dev',
  readyfordev: 'ready-for-dev',
  inprogress: 'in-progress',
  'in-progress': 'in-progress',
  'in-development': 'in-progress',
  wip: 'in-progress',
  review: 'review',
  'in-review': 'review',
  'ready-for-review': 'review',
  'code-review': 'review',
  done: 'done',
  completed: 'done',
  complete: 'done',
  closed: 'done',
};

export function normalizeStoryStatus(raw?: string): StoryStatus | undefined {
  if (!raw) return undefined;
  const s = raw
    .toLowerCase()
    .replace(/[*_`"']/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z-]/g, '')
    .replace(/^-+|-+$/g, '');
  if (STATUS_MAP[s]) return STATUS_MAP[s];
  const first = s.split('-')[0];
  if (s.startsWith('in-prog')) return 'in-progress';
  if (s.startsWith('ready-for-rev')) return 'review';
  if (s.startsWith('ready')) return 'ready-for-dev';
  return STATUS_MAP[first];
}

export function emptyCounts(): Record<StoryStatus, number> {
  return { backlog: 0, drafted: 0, 'ready-for-dev': 0, 'in-progress': 0, review: 0, done: 0 };
}
