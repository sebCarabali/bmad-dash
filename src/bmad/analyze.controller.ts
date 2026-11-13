import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { buildDashboard, buildScanContext } from './core/analyzer';
import { buildSpec, StorySpecInput, validateSpecInput } from './core/spec-builder';
import { CommandStyle, SpecContext, VFile } from './core/types';

const STYLES: CommandStyle[] = ['v6-slash', 'v6-agent', 'v6-dash', 'v4'];
const MAX_FILES = 25000;

interface AnalyzeBody {
  root: string;
  files: VFile[];
  markers?: string[];
  style?: string;
}

interface SpecBuildBody {
  spec: StorySpecInput;
  context: SpecContext;
  sprintStatusContent?: string;
}

/** Análisis sin estado: el navegador envía los archivos BMAD que leyó de la carpeta. */
@Controller()
export class AnalyzeController {
  @Post('analyze')
  @HttpCode(200)
  analyze(@Body() body: AnalyzeBody) {
    if (!body || !Array.isArray(body.files)) throw new BadRequestException('Envía la lista de archivos del proyecto.');
    if (body.files.length > MAX_FILES) throw new BadRequestException(`Demasiados archivos (${body.files.length}).`);
    const files: VFile[] = body.files
      .filter((f) => f && typeof f.path === 'string' && !f.path.includes('..'))
      .map((f) => ({
        path: String(f.path),
        mtime: Number(f.mtime) || 0,
        size: Number(f.size) || 0,
        content: typeof f.content === 'string' ? f.content : undefined,
      }));
    const ctx = buildScanContext({
      root: String(body.root || 'proyecto').slice(0, 200),
      source: 'browser',
      files,
      markers: Array.isArray(body.markers) ? body.markers.map(String) : [],
    });
    return buildDashboard(ctx, STYLES.includes(body.style as CommandStyle) ? (body.style as CommandStyle) : undefined);
  }

  /** Genera el markdown de una historia (y el sprint-status actualizado si se envía el original). */
  @Post('spec/build')
  @HttpCode(200)
  buildSpec(@Body() body: SpecBuildBody) {
    if (!body?.context) throw new BadRequestException('Falta el contexto del proyecto.');
    const err = validateSpecInput(body.spec);
    if (err) throw new BadRequestException(err);
    return buildSpec(body.spec, body.context, typeof body.sprintStatusContent === 'string' ? body.sprintStatusContent : undefined);
  }
}
