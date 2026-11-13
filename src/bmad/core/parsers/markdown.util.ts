export interface MdSection {
  level: number;
  title: string;
  content: string;
}

/** Divide un markdown en secciones por encabezados (ignora encabezados dentro de bloques de código). */
export function splitSections(md: string): MdSection[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: MdSection[] = [];
  let current: MdSection = { level: 0, title: '', content: '' };
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const m = !inCode && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      sections.push(current);
      current = { level: m[1].length, title: m[2].trim(), content: '' };
    } else {
      current.content += line + '\n';
    }
  }
  sections.push(current);
  return sections;
}

/** Devuelve el contenido de una sección incluyendo sus subsecciones. */
export function sectionWithChildren(sections: MdSection[], matcher: RegExp, level?: number): string | undefined {
  const idx = sections.findIndex((s) => s.level > 0 && matcher.test(s.title) && (level === undefined || s.level === level));
  if (idx < 0) return undefined;
  const base = sections[idx].level;
  let out = sections[idx].content;
  for (let i = idx + 1; i < sections.length && sections[i].level > base; i++) {
    out += `${'#'.repeat(sections[i].level)} ${sections[i].title}\n${sections[i].content}`;
  }
  return out;
}

/** Elementos de lista de primer nivel (numerados o con viñeta), uniendo líneas de continuación. */
export function topLevelListItems(text: string | undefined): string[] {
  if (!text) return [];
  const items: string[] = [];
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const m = /^(\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[2];
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ' ' + line.trim();
    } else if (current !== null && line.trim() === '') {
      items.push(current.trim());
      current = null;
    }
  }
  if (current !== null) items.push(current.trim());
  return items.filter((i) => i.length > 0);
}

export function stripMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export function humanizeSlug(slug: string): string {
  const s = slug.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
