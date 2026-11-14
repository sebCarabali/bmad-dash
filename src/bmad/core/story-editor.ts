import { StoryStatus, STORY_STATUSES } from './types';

/** Estados de BMAD v4 equivalentes (sección "## Status" de la historia). */
const V4_STATUS: Record<StoryStatus, string> = {
  backlog: 'Draft',
  drafted: 'Draft',
  'ready-for-dev': 'Approved',
  'in-progress': 'InProgress',
  review: 'Review',
  done: 'Done',
};

export function isStoryStatus(s: string): s is StoryStatus {
  return (STORY_STATUSES as string[]).includes(s);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cambia el estado de una historia en sprint-status.yaml conservando comentarios, orden y sangría.
 * Si la clave no existe, la inserta en el bloque de su épica.
 */
export function setSprintStoryStatus(yaml: string, key: string, status: StoryStatus): { content: string; changed: boolean } {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const re = new RegExp(`^(\\s+${escapeRe(key)}\\s*:\\s*)([^#\\s]*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) {
      if (m[2] === status) return { content: yaml, changed: false };
      lines[i] = `${m[1]}${status}${m[3]}`;
      return { content: lines.join(nl), changed: true };
    }
  }
  return { content: yaml, changed: false };
}

/** Cambia la línea de estado del archivo de la historia: "Status: x" (v6) o la sección "## Status" (v4). */
export function setStoryFileStatus(md: string, status: StoryStatus): { content: string; changed: boolean } {
  const nl = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  // v6: "Status: in-progress" (posiblemente en negrita)
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*\**Status\**\s*:\s*\**\s*)([^*\s][^*]*?)(\s*\**\s*)$/i.exec(lines[i]);
    if (m) {
      if (m[2].trim() === status) return { content: md, changed: false };
      lines[i] = `${m[1]}${status}${m[3]}`;
      return { content: lines.join(nl), changed: true };
    }
  }
  // v4: "## Status" seguido del valor en la primera línea no vacía
  const h = lines.findIndex((l) => /^##\s*Status\s*$/i.test(l.trim()));
  if (h >= 0) {
    for (let i = h + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) break;
      if (lines[i].trim()) {
        const v4 = V4_STATUS[status];
        if (lines[i].trim() === v4) return { content: md, changed: false };
        lines[i] = v4;
        return { content: lines.join(nl), changed: true };
      }
    }
    lines.splice(h + 1, 0, '', V4_STATUS[status]);
    return { content: lines.join(nl), changed: true };
  }
  // Sin estado: se añade debajo del título
  const t = lines.findIndex((l) => /^#\s/.test(l));
  lines.splice(t >= 0 ? t + 1 : 0, 0, '', `Status: ${status}`);
  return { content: lines.join(nl), changed: true };
}

/**
 * Marca o desmarca la tarea número `index` (en el orden en que aparecen las casillas
 * de la sección de tareas, contando subtareas), igual que el parser del dashboard.
 */
export function setTaskChecked(md: string, index: number, done: boolean): { content: string; changed: boolean } {
  const nl = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  let inTasks = false;
  let inCode = false;
  let level = 0;
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inCode = !inCode;
    const h = !inCode && /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (/tasks|subtasks|tareas/i.test(h[2])) {
        inTasks = true;
        level = h[1].length;
      } else if (inTasks && h[1].length <= level) inTasks = false;
      continue;
    }
    if (!inTasks) continue;
    const m = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+.*)$/.exec(line.replace(/\t/g, '  '));
    if (m && ++n === index) {
      const cur = m[2].toLowerCase() === 'x';
      if (cur === done) return { content: md, changed: false };
      const original = /^(\s*[-*+]\s+\[)( |x|X)(\].*)$/.exec(line);
      lines[i] = `${original[1]}${done ? 'x' : ' '}${original[3]}`;
      return { content: lines.join(nl), changed: true };
    }
  }
  return { content: md, changed: false };
}
