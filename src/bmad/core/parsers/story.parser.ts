import { ParsedStory, TaskItem, normalizeStoryStatus } from '../types';
import { sectionWithChildren, splitSections, stripMd, topLevelListItems, humanizeSlug } from './markdown.util';

/** Nombres de archivo de historia: v6 "1-2-slug.md", v4 "1.2.slug.md" o "1.2.story.md". */
export const STORY_FILE_RE = /^(\d+)[-.](\d+)(?:[-.](.+))?\.md$/i;

export function looksLikeStory(content: string): boolean {
  return /^#{1,2}\s*Story\b/im.test(content) || /^Status\s*:/im.test(content) || /^##\s*Status\s*$/im.test(content);
}

export function parseStory(fileName: string, content: string, relativePath: string, mtime: number): ParsedStory | null {
  const fm = STORY_FILE_RE.exec(fileName);
  if (!fm) return null;
  const md = content.replace(/\r\n/g, '\n');

  let epic = Number(fm[1]);
  let number = Number(fm[2]);
  const rawSlug = (fm[3] ?? '').replace(/\.story$/i, '');
  const slug = rawSlug && rawSlug.toLowerCase() !== 'story' ? rawSlug : undefined;

  // Título: "# Story 1.2: Título"
  let title = '';
  const tm = /^#{1,2}\s*Story\s+(\d+)\.(\d+)\s*[:\-–—.]?\s*(.*)$/im.exec(md);
  if (tm) {
    epic = Number(tm[1]);
    number = Number(tm[2]);
    title = stripMd(tm[3] ?? '');
  }
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(md);
    title = h1 ? stripMd(h1[1]) : slug ? humanizeSlug(slug) : `Historia ${epic}.${number}`;
  }

  const sections = splitSections(md);

  // Estado: "Status: in-progress" (v6) o sección "## Status" (v4)
  let rawStatus: string | undefined;
  const inline = /^\**Status\**\s*:\s*\**\s*(.+?)\s*\**\s*$/im.exec(md);
  if (inline) rawStatus = inline[1];
  else {
    const sec = sections.find((s) => /^status$/i.test(s.title));
    if (sec) rawStatus = sec.content.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  }

  const storySec = sectionWithChildren(sections, /^story$/i);
  const userStory = storySec
    ? storySec
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .join(' ')
        .trim() || undefined
    : undefined;

  const acSec = sectionWithChildren(sections, /acceptance\s+criteria|criterios\s+de\s+aceptaci/i);
  const acceptanceCriteria = topLevelListItems(acSec).map(stripMd);

  const tasksSec = sectionWithChildren(sections, /tasks|subtasks|tareas/i);
  const tasks: TaskItem[] = [];
  if (tasksSec) {
    for (const raw of tasksSec.split('\n')) {
      const line = raw.replace(/\t/g, '  ');
      const m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
      if (m) {
        tasks.push({
          level: Math.floor(m[1].length / 2),
          done: m[2].toLowerCase() === 'x',
          text: stripMd(m[3]),
          reviewFollowUp: /\[AI-Review\]/i.test(m[3]),
        });
      }
    }
  }

  // Revisión de código (BMAD v6: "## Senior Developer Review (AI)"; v4: "## QA Results")
  const reviewSec = sectionWithChildren(sections, /senior developer review|code review|qa results|revisi[oó]n/i);
  let reviewOutcome: string | undefined;
  let pendingReviewItems = tasks.filter((t) => t.reviewFollowUp && !t.done).length;
  if (reviewSec) {
    const om = /(?:Outcome|Resultado|Gate(?:\s+Status)?|Decision)\s*\**\s*:\s*\**\s*([A-Za-zÁÉÍÓÚáéíóú][\w \-áéíóú]*)/i.exec(reviewSec);
    if (om) reviewOutcome = om[1].trim();
    pendingReviewItems += (reviewSec.match(/^\s*[-*+]\s+\[ \]/gm) ?? []).length;
  }

  const fileListSec = sectionWithChildren(sections, /^file\s+list$/i);
  const fileList = topLevelListItems(fileListSec).map(stripMd).filter((f) => !/^\(.*\)$/.test(f));

  const changeLogSec = sectionWithChildren(sections, /change\s*log/i);
  const changeLogCount = changeLogSec ? (changeLogSec.match(/^\|\s*\d{4}-\d{2}-\d{2}/gm) ?? []).length + topLevelListItems(changeLogSec).length : 0;

  return {
    epic,
    number,
    id: `${epic}.${number}`,
    slug,
    title,
    rawStatus,
    status: normalizeStoryStatus(rawStatus),
    userStory,
    acceptanceCriteria,
    tasks,
    tasksTotal: tasks.length,
    tasksDone: tasks.filter((t) => t.done).length,
    reviewOutcome,
    pendingReviewItems,
    fileList,
    changeLogCount,
    relativePath,
    mtime,
  };
}
