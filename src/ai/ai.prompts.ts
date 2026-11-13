/** Contexto del proyecto que envía el frontend (ya resumido). */
export interface AiContext {
  project?: { name?: string; version?: string; commandStyle?: string; storiesDir?: string; sprintStatusFile?: string };
  stats?: Record<string, unknown>;
  epics?: { number: number; title: string; status: string; progress: number; description?: string }[];
  stories?: { id: string; title: string; status: string; tasksDone?: number; tasksTotal?: number; warnings?: string[]; relativePath?: string }[];
  suggestions?: { priority: string; title: string; steps: string[]; reason?: string }[];
  alerts?: string[];
  focusStory?: { id: string; markdown: string };
  docs?: { path: string; content: string }[];
  specDraft?: Record<string, unknown>;
  specMarkdown?: string;
}

export type AiTask = 'chat' | 'draft-story' | 'review-story';

const MAX_DOC_CHARS = 60_000;
const MAX_DOCS = 6;
const MAX_STORY_CHARS = 40_000;

export const BASE_INSTRUCTIONS = `Eres el asistente de un dashboard de proyectos que usan BMAD Method (Breakthrough Method for Agile AI-Driven Development).
Actúas como un Scrum Master / Product Owner experto en BMAD: conoces el ciclo sprint-planning → create-story → story-context/story-ready → dev-story → code-review → story-done → retrospective, y correct-course para cambios de alcance.

Reglas:
- Responde en el idioma del usuario (por defecto, español). Sé concreto y breve; usa listas cuando ayuden.
- Básate en el contexto del proyecto que se te da. Si algo no está en el contexto, dilo en vez de inventarlo (no inventes archivos, historias ni rutas).
- Refiérete a las historias por su id (p. ej. 1.3) y a las épicas por su número.
- Cuando recomiendes un comando BMAD, usa exactamente el formato de los "Comandos sugeridos" del contexto (el usuario eligió ese formato).
- BMAD trabaja una historia a la vez: no recomiendes empezar otra si hay una en progreso o en revisión, salvo que el usuario lo pida.
- Los criterios de aceptación deben ser verificables (Given/When/Then o valores medibles) y cada tarea debe indicar qué AC cubre con "(AC: n)".`;

function trunc(s: string, max: number) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…[recortado: ${s.length - max} caracteres más]` : s;
}

/** Contexto estable del proyecto (se cachea con prompt caching entre turnos del chat). */
export function projectContext(ctx: AiContext): string {
  const p = ctx.project ?? {};
  const lines: string[] = [];
  lines.push(`# Proyecto: ${p.name ?? 'sin nombre'} (${p.version ?? 'BMAD'})`);
  if (p.storiesDir) lines.push(`Carpeta de historias: ${p.storiesDir}`);
  if (p.sprintStatusFile) lines.push(`sprint-status: ${p.sprintStatusFile}`);
  if (ctx.stats) lines.push(`Estadísticas: ${JSON.stringify(ctx.stats)}`);

  if (ctx.epics?.length) {
    lines.push('\n## Épicas');
    for (const e of ctx.epics.slice(0, 60))
      lines.push(`- Épica ${e.number}: ${e.title} — ${e.status}, ${e.progress}% hecho${e.description ? ` — ${trunc(e.description.replace(/\s+/g, ' '), 300)}` : ''}`);
  }
  if (ctx.stories?.length) {
    lines.push('\n## Historias (id · título · estado · tareas)');
    for (const s of ctx.stories.slice(0, 400)) {
      const tasks = s.tasksTotal ? ` · tareas ${s.tasksDone}/${s.tasksTotal}` : '';
      const warn = s.warnings?.length ? ` · ⚠ ${s.warnings.join('; ')}` : '';
      lines.push(`- ${s.id} · ${s.title} · ${s.status}${tasks}${s.relativePath ? ` · ${s.relativePath}` : ''}${warn}`);
    }
  }
  if (ctx.suggestions?.length) {
    lines.push(`\n## Comandos sugeridos por el dashboard (formato elegido: ${p.commandStyle ?? 'v6'})`);
    for (const s of ctx.suggestions.slice(0, 15)) lines.push(`- [${s.priority}] ${s.title}: ${s.steps.join(' → ')}${s.reason ? ` — ${s.reason}` : ''}`);
  }
  if (ctx.alerts?.length) {
    lines.push('\n## Alertas');
    for (const a of ctx.alerts.slice(0, 40)) lines.push(`- ${a}`);
  }
  for (const d of (ctx.docs ?? []).slice(0, MAX_DOCS)) {
    lines.push(`\n## Documento: ${d.path}\n<documento ruta="${d.path}">\n${trunc(d.content, MAX_DOC_CHARS)}\n</documento>`);
  }
  return lines.join('\n');
}

/** Instrucciones del turno según la tarea (van después del bloque cacheado). */
export function taskInstructions(task: AiTask, ctx: AiContext): string {
  const parts: string[] = [];
  if (ctx.focusStory?.markdown) {
    parts.push(`## Historia en foco: ${ctx.focusStory.id}\n<historia>\n${trunc(ctx.focusStory.markdown, MAX_STORY_CHARS)}\n</historia>`);
  }
  if (task === 'draft-story') {
    parts.push(`## Tarea: redactar una especificación de historia BMAD
Datos del formulario (pueden estar incompletos; complétalos con el contexto de la épica, el PRD y la arquitectura):
${JSON.stringify(ctx.specDraft ?? {}, null, 2)}

Devuelve SOLO un bloque \`\`\`json con este formato exacto (sin texto adicional fuera del bloque):
{
  "title": "título corto de la historia",
  "role": "rol del usuario (para 'As a')",
  "want": "lo que quiere (para 'I want')",
  "benefit": "beneficio (para 'so that')",
  "acceptanceCriteria": ["criterio verificable 1", "criterio verificable 2"],
  "tasks": "Tarea 1 (AC: 1)\\n  - Subtarea 1.1\\nTarea 2 (AC: 2)",
  "devNotes": "notas técnicas en markdown: patrones de la arquitectura, archivos/módulos a tocar, pruebas",
  "references": ["[Source: ruta/documento.md#Sección]"]
}
Reglas: entre 3 y 7 criterios de aceptación verificables; cada tarea termina en "(AC: n[, m])" y todos los AC quedan cubiertos; subtareas con dos espacios y guion;
respeta el alcance de la historia planificada; usa el idioma de los datos del formulario (si están vacíos, español); en references cita solo documentos que aparecen en el contexto.`);
  } else if (task === 'review-story') {
    parts.push(`## Tarea: revisar una especificación de historia antes de pasarla a desarrollo
<borrador>
${trunc(ctx.specMarkdown ?? '', MAX_STORY_CHARS)}
</borrador>
Evalúa como un PO exigente: claridad de la user story, criterios verificables y completos, cobertura AC↔tareas, tamaño (¿cabe en una sesión de dev-story?),
coherencia con la épica/PRD/arquitectura del contexto, riesgos y dependencias con otras historias.
Formato: un veredicto en una línea (Lista para desarrollo / Necesita cambios), luego "Problemas" y "Sugerencias" como listas, y si aplica criterios reescritos.`);
  }
  return parts.join('\n\n');
}

export const QUICK_TASK_MAX_TOKENS: Record<AiTask, number> = {
  chat: 4096,
  'draft-story': 6000,
  'review-story': 3000,
};
