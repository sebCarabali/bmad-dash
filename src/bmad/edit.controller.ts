import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { isStoryStatus, setSprintStoryStatus, setStoryFileStatus, setTaskChecked } from './core/story-editor';

/**
 * Transformaciones de archivos sin estado (modo carpeta del navegador):
 * el navegador envía el contenido actual y recibe el nuevo para escribirlo en la carpeta.
 */
@Controller('edit')
export class EditController {
  @Post('status')
  @HttpCode(200)
  status(@Body() body: { key?: string; status: string; sprintStatus?: string; storyFile?: string }) {
    if (!body || !isStoryStatus(body.status)) throw new BadRequestException('Estado no válido.');
    const out: { sprintStatus?: string; sprintChanged?: boolean; storyFile?: string; storyChanged?: boolean } = {};
    if (typeof body.sprintStatus === 'string' && body.key) {
      const r = setSprintStoryStatus(body.sprintStatus, body.key, body.status);
      out.sprintStatus = r.content;
      out.sprintChanged = r.changed;
    }
    if (typeof body.storyFile === 'string') {
      const r = setStoryFileStatus(body.storyFile, body.status);
      out.storyFile = r.content;
      out.storyChanged = r.changed;
    }
    return out;
  }

  @Post('task')
  @HttpCode(200)
  task(@Body() body: { storyFile: string; index: number; done: boolean }) {
    if (typeof body?.storyFile !== 'string' || !Number.isInteger(body.index) || body.index < 0) throw new BadRequestException('Datos de tarea no válidos.');
    return setTaskChecked(body.storyFile, body.index, !!body.done);
  }
}
