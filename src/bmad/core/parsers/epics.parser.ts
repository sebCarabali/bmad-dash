import { PlannedEpic, PlannedStory } from '../types';
import { stripMd, topLevelListItems } from './markdown.util';

export const EPICS_FILE_RE = /^(epics?|epic[-_ ]?\d+.*|.*[-_]epics?)\.md$/i;

const EPIC_HEADING = /^(#{1,3})\s*Epic\s+(\d+)(?:\s*[:\-–—.]\s*|\s+)(.+?)\s*$/i;
const STORY_HEADING = /^(#{2,5})\s*Story\s+(\d+)\.(\d+)\s*[:\-–—.]?\s*(.*?)\s*$/i;

/**
 * Lee épicas e historias planificadas desde epics.md o archivos epic-N-*.md
 * (formato generado por el workflow create-epics-and-stories de BMAD).
 */
export function parseEpicsFile(content: string, relativePath: string): PlannedEpic[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const epics: PlannedEpic[] = [];
  let epic: PlannedEpic | null = null;
  let story: PlannedStory | null = null;
  let epicLevel = 0;
  let inCode = false;

  const flushStory = () => {
    if (story && epic) {
      finalizeStory(story);
      epic.stories.push(story);
    }
    story = null;
  };

  // Archivos "epic-3-pagos.md" sin encabezado "Epic 3:" explícito
  const fileEpic = /epic[-_ ]?(\d+)/i.exec(relativePath.split(/[\\/]/).pop() ?? '');

  for (const line of lines) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) {
      if (story) story.body += line + '\n';
      continue;
    }
    const em = EPIC_HEADING.exec(line);
    if (em) {
      flushStory();
      epicLevel = em[1].length;
      epic = { number: Number(em[2]), title: stripMd(em[3]), description: '', stories: [], sourceFile: relativePath };
      epics.push(epic);
      continue;
    }
    const sm = STORY_HEADING.exec(line);
    if (sm) {
      flushStory();
      const e = Number(sm[2]);
      if (!epic || epic.number !== e) {
        epic = epics.find((x) => x.number === e) ?? null;
        if (!epic) {
          epic = { number: e, title: `Epic ${e}`, description: '', stories: [], sourceFile: relativePath };
          epics.push(epic);
        }
      }
      story = { epic: e, number: Number(sm[3]), id: `${e}.${sm[3]}`, title: stripMd(sm[4] || `Historia ${e}.${sm[3]}`), acceptanceCriteria: [], body: '' };
      continue;
    }
    // Un encabezado de nivel igual o superior a la épica cierra la épica actual
    const hm = /^(#{1,6})\s+/.exec(line);
    if (hm && epic && hm[1].length <= epicLevel) {
      // Encabezados como "## Overview" cierran la épica actual
      flushStory();
      epic = null;
      continue;
    }
    if (story) story.body += line + '\n';
    else if (epic) epic.description += line + '\n';
  }
  flushStory();

  if (epics.length === 0 && fileEpic) {
    const h1 = /^#\s+(.+)$/m.exec(content);
    epics.push({
      number: Number(fileEpic[1]),
      title: h1 ? stripMd(h1[1]) : `Epic ${fileEpic[1]}`,
      description: content.slice(0, 1500),
      stories: [],
      sourceFile: relativePath,
    });
  }

  for (const e of epics) {
    e.description = e.description.trim();
    const gm = /\*{0,2}(?:Goal|Objetivo|Epic Goal)\*{0,2}\s*:\s*\*{0,2}\s*(.+)/i.exec(e.description);
    if (gm) e.goal = stripMd(gm[1]);
  }
  return epics;
}

function finalizeStory(story: PlannedStory) {
  story.body = story.body.trim();
  const text = story.body;
  const asA = /As an?\s+(.+?),?\s*\n?\s*I want\s+(.+?),?\s*\n?\s*so that\s+(.+?)(?:\.|\n|$)/is.exec(text.replace(/\*\*/g, ''));
  const comoUn = /Como\s+(?:un|una)?\s*(.+?),?\s*\n?\s*quiero\s+(.+?),?\s*\n?\s*para\s+(?:que\s+)?(.+?)(?:\.|\n|$)/is.exec(text.replace(/\*\*/g, ''));
  if (asA) story.userStory = `As a ${asA[1].trim()}, I want ${asA[2].trim()}, so that ${asA[3].trim()}.`;
  else if (comoUn) story.userStory = `Como ${comoUn[1].trim()}, quiero ${comoUn[2].trim()}, para ${comoUn[3].trim()}.`;

  const acIdx = text.search(/acceptance criteria|criterios de aceptaci/i);
  if (acIdx >= 0) {
    const after = text.slice(acIdx).split('\n').slice(1).join('\n');
    const stop = after.search(/^\s*(#{1,6}\s|\*\*(?:Technical|Prerequisites|Notes|Dependencias|Notas))/im);
    story.acceptanceCriteria = topLevelListItems(stop >= 0 ? after.slice(0, stop) : after).map(stripMd);
    if (story.acceptanceCriteria.length === 0) {
      // Formato Given/When/Then en líneas sueltas
      const gwt = after.match(/^\s*\*{0,2}(Given|When|Then|And|Dado|Cuando|Entonces|Y)\b.*$/gim);
      if (gwt) story.acceptanceCriteria = [gwt.map((l) => stripMd(l.trim())).join(' ')];
    }
  }
}
