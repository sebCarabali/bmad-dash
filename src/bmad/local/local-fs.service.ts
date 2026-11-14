import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isLocalMode } from '../../app.setup';
import { AnalyzeInput, CONFIG_FILES, IGNORED_DIRS, MAX_FILE_SIZE, METHOD_DIRS, buildDashboard, buildScanContext, needsContent, toSpecContext } from '../core/analyzer';
import { buildSpec, StorySpecInput, validateSpecInput } from '../core/spec-builder';
import { isStoryStatus, setSprintStoryStatus, setStoryFileStatus, setTaskChecked } from '../core/story-editor';
import { CommandStyle, VFile } from '../core/types';

export const BMAD_DIR_NAMES = ['_bmad', 'bmad', '.bmad-core', '_bmad-output', '.bmad'];
const ALLOWED_DOT_DIRS = new Set(['.bmad-output']);
const MAX_DEPTH = 8;
const MAX_FILES = 25000;

/** Modo local: lee el proyecto directamente del disco del servidor (tu PC). */
@Injectable()
export class LocalFsService {
  assertLocal() {
    if (!isLocalMode()) throw new ForbiddenException('El acceso por ruta solo está disponible al ejecutar la app en tu equipo. Usa "Seleccionar carpeta".');
  }

  async resolveRoot(input: string): Promise<string> {
    this.assertLocal();
    if (!input || !input.trim()) throw new BadRequestException('Indica la ruta del proyecto.');
    let p = input.trim().replace(/^["']|["']$/g, '');
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch {
      throw new NotFoundException(`La ruta no existe: ${p}`);
    }
    if (stat.isFile()) p = path.dirname(p);
    else if (!stat.isDirectory()) throw new BadRequestException(`No es una carpeta: ${p}`);
    const base = path.basename(p);
    const parent = path.dirname(p);
    const parentBase = path.basename(parent);
    if (BMAD_DIR_NAMES.includes(base)) p = parent;
    else if (BMAD_DIR_NAMES.includes(parentBase)) p = path.dirname(parent);
    else if (base === 'stories' && parentBase === 'docs') p = path.dirname(parent);
    else if (['sprint-artifacts', 'implementation-artifacts', 'planning-artifacts'].includes(base) && parentBase === 'docs') p = path.dirname(parent);
    return p;
  }

  async load(input: string): Promise<AnalyzeInput> {
    const root = await this.resolveRoot(input);
    const files: VFile[] = [];
    await walk(root, root, 0, files);
    for (const c of CONFIG_FILES) {
      const abs = path.join(root, c);
      try {
        const st = await fs.stat(abs);
        files.push({ path: c, mtime: st.mtimeMs, size: st.size, content: await fs.readFile(abs, 'utf8') });
      } catch {
        /* no existe */
      }
    }
    const markers: string[] = [];
    try {
      markers.push(...(await fs.readdir(root)));
    } catch {
      /* ignorar */
    }
    if (await exists(path.join(root, 'bmad', 'bmm'))) markers.push('bmad/bmm');
    return { root, source: 'local', files, markers };
  }

  /**
   * Firma barata del estado (rutas + fechas + tamaños de los archivos BMAD relevantes),
   * sin leer contenidos: el frontend la consulta a menudo y solo recalcula si cambia.
   */
  async signature(input: string) {
    const root = await this.resolveRoot(input);
    const files: VFile[] = [];
    await walk(root, root, 0, files, false);
    const relevant = files.filter((f) => needsContent(f.path) || /\.md$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash('sha1');
    for (const f of relevant) hash.update(`${f.path}|${Math.round(f.mtime)}|${f.size}\n`);
    hash.update(`total:${files.length}`);
    return { signature: hash.digest('hex'), files: relevant.length };
  }

  async detect(input: string) {
    const data = await this.load(input);
    const ctx = buildScanContext(data);
    return { root: data.root, version: ctx.version, isBmad: ctx.version !== 'unknown' };
  }

  async dashboard(input: string, style?: CommandStyle) {
    return buildDashboard(buildScanContext(await this.load(input)), style);
  }

  async storyMarkdown(input: string, relativePath: string) {
    const root = await this.resolveRoot(input);
    if (!/\.(md|ya?ml)$/i.test(relativePath ?? '')) throw new BadRequestException('Solo se pueden leer archivos .md o .yaml');
    const abs = path.resolve(root, relativePath);
    if (!abs.startsWith(root + path.sep)) throw new BadRequestException('Ruta fuera del proyecto');
    try {
      return { markdown: await fs.readFile(abs, 'utf8') };
    } catch {
      throw new NotFoundException(`No se pudo leer ${relativePath}`);
    }
  }

  async saveSpec(input: string, spec: StorySpecInput & { updateSprintStatus?: boolean }) {
    const err = validateSpecInput(spec);
    if (err) throw new BadRequestException(err);
    const ctx = buildScanContext(await this.load(input));
    const specCtx = toSpecContext(ctx);
    const result = buildSpec(spec, specCtx, spec.updateSprintStatus !== false ? ctx.sprintContent : undefined);
    const errors = result.quality.filter((q) => q.level === 'error');
    if (errors.length) throw new BadRequestException(errors.map((q) => q.message).join(' '));

    const target = path.resolve(ctx.root, result.relativeTarget);
    if (!target.startsWith(ctx.root + path.sep)) throw new BadRequestException('La carpeta de historias está fuera del proyecto.');
    if (!spec.overwrite && (await exists(target))) throw new ConflictException(`Ya existe ${result.relativeTarget}. Activa "sobrescribir" para reemplazarlo.`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, result.markdown, 'utf8');

    let sprintUpdated = false;
    if (result.sprintStatusChanged && ctx.sprint) {
      await fs.writeFile(path.resolve(ctx.root, ctx.sprint.relativePath), result.sprintStatusContent, 'utf8');
      sprintUpdated = true;
    }
    return { ...result, sprintStatusContent: undefined, saved: true, savedPath: result.relativeTarget, sprintUpdated };
  }

  /** Cambia el estado de una historia en sprint-status.yaml y en su archivo. */
  async setStoryStatus(input: string, id: string, status: string, scope: 'both' | 'sprint' | 'file' = 'both') {
    if (!isStoryStatus(status)) throw new BadRequestException('Estado no válido.');
    const ctx = buildScanContext(await this.load(input));
    const story = ctx.parsedStories.find((s) => s.id === id);
    const entry = ctx.sprint?.stories.find((s) => `${s.epic}.${s.number}` === id);
    if (!story && !entry) throw new NotFoundException(`No se encontró la historia ${id}`);
    const changed: string[] = [];
    if (entry && ctx.sprint && scope !== 'file') {
      const abs = this.inside(ctx.root, ctx.sprint.relativePath);
      const r = setSprintStoryStatus(await fs.readFile(abs, 'utf8'), entry.key, status);
      if (r.changed) {
        await fs.writeFile(abs, r.content, 'utf8');
        changed.push(ctx.sprint.relativePath);
      }
    }
    if (story && scope !== 'sprint') {
      const abs = this.inside(ctx.root, story.relativePath);
      const r = setStoryFileStatus(await fs.readFile(abs, 'utf8'), status);
      if (r.changed) {
        await fs.writeFile(abs, r.content, 'utf8');
        changed.push(story.relativePath);
      }
    }
    return { changed };
  }

  /** Marca o desmarca una tarea del archivo de la historia. */
  async setTask(input: string, id: string, index: number, done: boolean) {
    const ctx = buildScanContext(await this.load(input));
    const story = ctx.parsedStories.find((s) => s.id === id);
    if (!story) throw new NotFoundException(`La historia ${id} no tiene archivo`);
    const abs = this.inside(ctx.root, story.relativePath);
    const r = setTaskChecked(await fs.readFile(abs, 'utf8'), index, done);
    if (r.changed) await fs.writeFile(abs, r.content, 'utf8');
    return { changed: r.changed };
  }

  /** Remoto de git (para detectar el repositorio de GitHub). */
  async gitRemote(input: string) {
    const root = await this.resolveRoot(input);
    try {
      return { config: await fs.readFile(path.join(root, '.git', 'config'), 'utf8') };
    } catch {
      return { config: null };
    }
  }

  /** Reportes de pruebas: JUnit (Surefire/Failsafe, Gradle, Jest) y TRX (.NET). */
  async testReports(input: string) {
    const root = await this.resolveRoot(input);
    const out: { path: string; mtime: number; content: string }[] = [];
    let total = 0;
    const visit = async (dir: string, depth: number) => {
      if (depth > 7 || out.length >= 400) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (e.isDirectory()) {
          if (['node_modules', '.git', '_bmad', '.bmad-core', 'obj', '.gradle', '.idea', '.vs', '.vscode'].includes(e.name)) continue;
          await visit(abs, depth + 1);
        } else if (isTestReport(rel)) {
          const st = await fs.stat(abs);
          if (st.size > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) continue;
          total += st.size;
          out.push({ path: rel, mtime: st.mtimeMs, content: await fs.readFile(abs, 'utf8') });
        }
      }
    };
    await visit(root, 0);
    return out;
  }

  private inside(root: string, rel: string) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) throw new BadRequestException('Ruta fuera del proyecto');
    return abs;
  }

  async listDir(input?: string) {
    this.assertLocal();
    let dir = input && input.trim() ? input.trim() : process.env.BMAD_DEFAULT_DIR || os.homedir();
    if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      throw new BadRequestException(`No se puede leer la carpeta: ${dir}`);
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const result = await Promise.all(
      dirs.slice(0, 400).map(async (name) => {
        const full = path.join(dir, name);
        let isBmad = false;
        try {
          isBmad = (await fs.readdir(full)).some((c) => BMAD_DIR_NAMES.includes(c));
        } catch {
          /* sin permisos */
        }
        return { name, path: full, isBmad };
      }),
    );
    const parent = path.dirname(dir);
    const roots: string[] = [];
    if (process.platform === 'win32') {
      for (const l of 'CDEFGHIJ') if (await exists(`${l}:\\`)) roots.push(`${l}:\\`);
    } else roots.push('/');
    return { path: dir, parent: parent !== dir ? parent : null, isBmad: entries.some((e) => BMAD_DIR_NAMES.includes(e.name)), roots, home: os.homedir(), entries: result };
  }
}

async function walk(root: string, dir: string, depth: number, out: VFile[], withContent = true) {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.includes(e.name) || METHOD_DIRS.includes(e.name)) continue;
      if (depth === 0 && e.name === 'bmad') continue;
      if (e.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(e.name)) continue;
      if (depth < MAX_DEPTH) await walk(root, abs, depth + 1, out, withContent);
    } else if (e.isFile() && /\.(md|ya?ml)$/i.test(e.name)) {
      try {
        const st = await fs.stat(abs);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const f: VFile = { path: rel, mtime: st.mtimeMs, size: st.size };
        if (withContent && st.size <= MAX_FILE_SIZE && needsContent(rel)) f.content = await fs.readFile(abs, 'utf8');
        out.push(f);
      } catch {
        /* ignorar */
      }
    }
  }
}

export function isTestReport(rel: string): boolean {
  const p = rel.toLowerCase();
  if (p.endsWith('.trx')) return true;
  if (!p.endsWith('.xml')) return false;
  return /(surefire|failsafe)-reports\/test-[^/]+\.xml$/.test(p) || /build\/test-results\/[^/]+\/[^/]+\.xml$/.test(p) || /(^|\/)(junit|test-results?|testresults)[^/]*\.xml$/.test(p) || /(^|\/)test-results\/[^/]+\.xml$/.test(p);
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
