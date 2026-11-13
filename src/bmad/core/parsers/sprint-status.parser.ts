import * as yaml from 'js-yaml';
import { SprintStatusData } from '../types';

/**
 * Lee sprint-status.yaml (BMAD v6):
 *   development_status:
 *     epic-1: in-progress
 *     1-1-user-auth: done
 *     epic-1-retrospective: optional
 */
export function parseSprintStatus(content: string, relativePath: string, mtime: number): SprintStatusData {
  let doc: any;
  try {
    doc = yaml.load(content) ?? {};
  } catch (e) {
    throw new Error(`No se pudo leer ${relativePath}: ${(e as Error).message}`);
  }
  const dev = doc.development_status ?? doc.developmentStatus ?? doc.stories ?? {};
  const data: SprintStatusData = {
    relativePath,
    mtime,
    project: doc.project ?? doc.project_name,
    projectKey: doc.project_key,
    storyLocation: doc.story_location ?? doc.stories_location,
    epics: {},
    retrospectives: {},
    stories: [],
  };
  for (const [key, value] of Object.entries(dev)) {
    const status = String(value ?? '').trim();
    let m: RegExpExecArray | null;
    if ((m = /^epic-(\d+)-retrospective$/i.exec(key))) data.retrospectives[Number(m[1])] = status;
    else if ((m = /^epic-(\d+)$/i.exec(key))) data.epics[Number(m[1])] = status;
    else if ((m = /^(\d+)-(\d+)(?:-(.+))?$/.exec(key)))
      data.stories.push({ key, epic: Number(m[1]), number: Number(m[2]), slug: m[3] ?? '', status });
  }
  return data;
}

/** Inserta una nueva historia en sprint-status.yaml conservando comentarios y orden. */
export function insertStoryInSprintStatus(content: string, epic: number, storyKey: string, status: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const existingIdx = lines.findIndex((l) => new RegExp(`^\\s+${escapeRe(storyKey)}\\s*:`).test(l));
  if (existingIdx >= 0) {
    // Ya registrada: solo avanza el estado si seguía en backlog
    const m = /^(\s+[^:]+:\s*)(\S+)(.*)$/.exec(lines[existingIdx]);
    if (m && m[2] === 'backlog' && status !== 'backlog') {
      lines[existingIdx] = `${m[1]}${status}${m[3]}`;
      return lines.join('\n');
    }
    return content;
  }

  const devIdx = lines.findIndex((l) => /^development_status\s*:/.test(l));
  if (devIdx < 0) {
    return `${content.trimEnd()}\n\ndevelopment_status:\n  epic-${epic}: backlog\n  ${storyKey}: ${status}\n  epic-${epic}-retrospective: optional\n`;
  }
  // Fin del bloque development_status
  let end = lines.length;
  for (let i = devIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith('#')) {
      end = i;
      break;
    }
  }
  const indentLine = lines.slice(devIdx + 1, end).find((l) => /^\s+\S/.test(l) && !l.trim().startsWith('#'));
  const indent = indentLine ? /^(\s+)/.exec(indentLine)[1] : '  ';

  let insertAt = -1;
  let epicLine = -1;
  for (let i = devIdx + 1; i < end; i++) {
    const t = lines[i].trim();
    if (new RegExp(`^epic-${epic}\\s*:`).test(t)) epicLine = i;
    if (new RegExp(`^${epic}-\\d+[-\\w]*\\s*:`).test(t)) insertAt = i + 1;
  }
  if (insertAt < 0 && epicLine >= 0) insertAt = epicLine + 1;
  if (insertAt < 0) {
    // Épica nueva al final del bloque
    let last = end;
    while (last > devIdx + 1 && lines[last - 1].trim() === '') last--;
    lines.splice(last, 0, `${indent}epic-${epic}: backlog`, `${indent}${storyKey}: ${status}`, `${indent}epic-${epic}-retrospective: optional`);
    return lines.join('\n');
  }
  lines.splice(insertAt, 0, `${indent}${storyKey}: ${status}`);
  return lines.join('\n');
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
