import { BmadVersion, CommandStyle, CommandSuggestion, EpicView, StoryView } from './types';

/** Agente BMAD responsable de cada workflow (BMM v6). */
const WORKFLOW_AGENT: Record<string, string> = {
  'workflow-init': 'analyst',
  'workflow-status': 'analyst',
  'create-epics-and-stories': 'pm',
  'implementation-readiness': 'architect',
  'sprint-planning': 'sm',
  'sprint-status': 'sm',
  'epic-tech-context': 'sm',
  'create-story': 'sm',
  'story-context': 'sm',
  'story-ready': 'sm',
  'dev-story': 'dev',
  'code-review': 'dev',
  'story-done': 'dev',
  retrospective: 'sm',
  'correct-course': 'sm',
};

/** Equivalentes en BMAD v4 (agente + comando de su menú). */
const V4_COMMANDS: Record<string, [string, string]> = {
  'workflow-init': ['@bmad-orchestrator', '*workflow-guidance'],
  'workflow-status': ['@bmad-orchestrator', '*status'],
  'create-epics-and-stories': ['@pm', '*create-prd'],
  'implementation-readiness': ['@po', '*execute-checklist-po'],
  'sprint-planning': ['@po', '*shard-doc docs/prd.md docs/prd'],
  'sprint-status': ['@sm', '*help'],
  'epic-tech-context': ['@architect', '*create-architecture'],
  'create-story': ['@sm', '*draft'],
  'story-context': ['@po', '*validate-story-draft'],
  'story-ready': ['@po', '*validate-story-draft'],
  'dev-story': ['@dev', '*develop-story'],
  'code-review': ['@qa', '*review'],
  'story-done': ['@dev', '*story-dod-checklist'],
  retrospective: ['@sm', '*correct-course'],
  'correct-course': ['@sm', '*correct-course'],
};

export interface SuggestionInput {
  stories: StoryView[];
  epics: EpicView[];
  hasSprintStatus: boolean;
  version: BmadVersion;
  plannedEpics: number;
}

export class SuggestionEngine {
  renderSteps(workflow: string, style: CommandStyle, argument?: string): { agent?: string; steps: string[] } {
    const agent = WORKFLOW_AGENT[workflow];
    switch (style) {
      case 'v4': {
        const [a, cmd] = V4_COMMANDS[workflow] ?? ['@bmad-orchestrator', `*${workflow}`];
        return { agent: a.replace('@', ''), steps: [a, argument ? `${cmd} ${argument}` : cmd] };
      }
      case 'v6-agent':
        return { agent, steps: [`/bmad:bmm:agents:${agent}`, `*${workflow}`] };
      case 'v6-dash':
        return { agent, steps: [`/bmad-bmm-${workflow}`] };
      case 'v6-slash':
      default:
        return { agent, steps: [`/bmad:bmm:workflows:${workflow}`] };
    }
  }

  build(input: SuggestionInput, style: CommandStyle): CommandSuggestion[] {
    const { stories, epics } = input;
    const out: CommandSuggestion[] = [];
    const add = (s: Omit<CommandSuggestion, 'steps' | 'agent'>) => {
      const r = this.renderSteps(s.workflow, style, style === 'v4' ? s.argument : undefined);
      out.push({ ...s, ...r });
    };
    const label = (s: StoryView) => `${s.id} · ${s.title}`;
    const fresh = 'Abre un chat nuevo (contexto limpio) antes de cada workflow.';

    // 1. Sin planificación o sin sprint-status
    if (stories.length === 0 && input.plannedEpics === 0) {
      add({
        priority: 'alta',
        workflow: 'workflow-status',
        title: 'Revisa en qué fase está el proyecto',
        reason: 'No se encontraron épicas ni historias. Completa la planificación (PRD, arquitectura, épicas).',
        tip: 'Si el proyecto es nuevo, empieza con workflow-init.',
      });
      add({ priority: 'media', workflow: 'create-epics-and-stories', title: 'Crea épicas e historias', reason: 'Divide el PRD en épicas e historias implementables.' });
      return out;
    }
    if (!input.hasSprintStatus && input.version !== 'v4') {
      add({
        priority: 'alta',
        workflow: 'sprint-planning',
        title: 'Genera el sprint-status.yaml',
        reason: 'Hay épicas o historias pero no existe sprint-status.yaml para hacer el seguimiento.',
        tip: fresh,
      });
    }

    // 2. Historias en revisión
    for (const s of stories.filter((x) => x.status === 'review')) {
      add({
        priority: 'alta',
        workflow: 'code-review',
        title: `Revisa el código de ${label(s)}`,
        reason: 'La historia está en "review" esperando la revisión del Senior Developer.',
        storyId: s.id,
        epic: s.epic,
        argument: s.relativePath,
        tip: 'Ideal: usa un modelo/LLM distinto al que implementó la historia.',
      });
    }

    // 3. Historias en progreso (o devueltas por la revisión)
    for (const s of stories.filter((x) => x.status === 'in-progress')) {
      const changes = s.pendingReviewItems > 0 || /change|cambio|block|fail/i.test(s.reviewOutcome ?? '');
      add({
        priority: 'alta',
        workflow: 'dev-story',
        title: changes ? `Atiende los hallazgos de revisión de ${label(s)}` : `Continúa la implementación de ${label(s)}`,
        reason: changes
          ? `La revisión dejó ${s.pendingReviewItems} acción(es) pendientes${s.reviewOutcome ? ` (resultado: ${s.reviewOutcome})` : ''}.`
          : s.tasksTotal
            ? `Progreso de tareas: ${s.tasksDone}/${s.tasksTotal}. El agente retoma desde la primera tarea sin marcar.`
            : 'La historia está en progreso.',
        storyId: s.id,
        epic: s.epic,
        argument: s.relativePath,
        tip: fresh,
      });
    }

    // 4. Listas para desarrollo
    const ready = stories.filter((x) => x.status === 'ready-for-dev');
    const busy = stories.some((x) => x.status === 'in-progress');
    ready.forEach((s, i) =>
      add({
        priority: i === 0 && !busy ? 'alta' : 'media',
        workflow: 'dev-story',
        title: `Implementa ${label(s)}`,
        reason: 'La historia está lista para desarrollo (ready-for-dev).',
        storyId: s.id,
        epic: s.epic,
        argument: s.relativePath,
        tip: busy ? 'Termina primero la historia en progreso: BMAD trabaja una historia a la vez.' : fresh,
      }),
    );

    // 5. Borradores
    for (const s of stories.filter((x) => x.status === 'drafted')) {
      if (input.version === 'v4') {
        add({ priority: 'media', workflow: 'story-ready', title: `Valida y aprueba el borrador ${label(s)}`, reason: 'La historia está en Draft; el PO debe validarla antes de implementar.', storyId: s.id, epic: s.epic, argument: s.relativePath });
      } else {
        add({
          priority: 'media',
          workflow: 'story-context',
          title: `Genera el contexto técnico de ${label(s)}`,
          reason: 'La historia está en borrador (drafted). story-context arma el contexto y la marca ready-for-dev.',
          storyId: s.id,
          epic: s.epic,
          argument: s.relativePath,
          tip: 'Alternativa rápida sin contexto: story-ready. En versiones recientes de v6, create-story ya deja la historia ready-for-dev.',
        });
      }
    }

    // 6. Siguiente historia del backlog
    const pipelineEmpty = !stories.some((x) => ['drafted', 'ready-for-dev'].includes(x.status));
    const nextBacklog = this.nextBacklogStory(stories, epics);
    if (nextBacklog) {
      const epic = epics.find((e) => e.number === nextBacklog.epic);
      if (epic && epic.status === 'backlog' && input.version === 'v6-alpha' && pipelineEmpty) {
        add({
          priority: 'media',
          workflow: 'epic-tech-context',
          title: `Prepara el contexto técnico de la Épica ${epic.number}`,
          reason: `La épica "${epic.title}" aún no tiene tech context y su primera historia está por crearse.`,
          epic: epic.number,
          tip: 'Opcional, pero mejora la calidad de las historias de la épica.',
        });
      }
      add({
        priority: pipelineEmpty ? (busy ? 'media' : 'alta') : 'baja',
        workflow: 'create-story',
        title: `Crea la siguiente historia: ${label(nextBacklog)}`,
        reason: pipelineEmpty
          ? 'No hay historias listas en cola; crea la siguiente del backlog para mantener el flujo.'
          : 'Puedes preparar la siguiente historia mientras se desarrolla la actual.',
        storyId: nextBacklog.id,
        epic: nextBacklog.epic,
        tip: 'create-story toma la primera historia en "backlog" de sprint-status.yaml.',
      });
    }

    // 7. Épicas terminadas
    for (const e of epics) {
      const allDone = e.stories.length > 0 && e.stories.every((s) => s.status === 'done');
      if (allDone && e.retrospective !== 'completed') {
        add({
          priority: 'media',
          workflow: 'retrospective',
          title: `Haz la retrospectiva de la Épica ${e.number}`,
          reason: `Todas las historias de "${e.title}" están terminadas.`,
          epic: e.number,
          tip: e.status !== 'done' ? 'Después marca la épica como done en sprint-status.yaml.' : undefined,
        });
      }
    }

    // 8. Problemas de sincronización
    const outOfSync = stories.filter((s) => s.warnings.some((w) => w.startsWith('Estado desincronizado')));
    if (outOfSync.length) {
      add({
        priority: 'baja',
        workflow: 'correct-course',
        title: `Sincroniza estados (${outOfSync.length} historia(s))`,
        reason: `Estados distintos entre sprint-status.yaml y los archivos: ${outOfSync.map((s) => s.id).join(', ')}. Corrige a mano o usa correct-course si cambió el alcance.`,
      });
    }

    // 9. Todo terminado
    if (stories.length > 0 && stories.every((s) => s.status === 'done')) {
      add({ priority: 'alta', workflow: 'workflow-status', title: '¡Todas las historias están terminadas!', reason: 'Revisa la siguiente fase o planifica nuevas épicas.' });
    }

    const order = { alta: 0, media: 1, baja: 2 };
    return out.sort((a, b) => order[a.priority] - order[b.priority]);
  }

  private nextBacklogStory(stories: StoryView[], epics: EpicView[]): StoryView | undefined {
    const backlog = stories.filter((s) => s.status === 'backlog');
    if (!backlog.length) return undefined;
    // Prioriza épicas ya iniciadas
    const active = epics.filter((e) => e.status === 'in-progress' || e.status === 'contexted').map((e) => e.number);
    return backlog.find((s) => active.includes(s.epic)) ?? backlog[0];
  }
}
