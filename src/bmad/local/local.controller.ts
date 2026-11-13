import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { LocalFsService } from './local-fs.service';
import { CommandStyle } from '../core/types';
import { StorySpecInput } from '../core/spec-builder';

const STYLES: CommandStyle[] = ['v6-slash', 'v6-agent', 'v6-dash', 'v4'];

/** Endpoints que leen el disco: solo responden cuando la app corre en tu equipo. */
@Controller('local')
export class LocalController {
  constructor(private readonly local: LocalFsService) {}

  @Get('detect')
  detect(@Query('path') path: string) {
    return this.local.detect(path);
  }

  @Get('dashboard')
  dashboard(@Query('path') path: string, @Query('style') style?: string) {
    return this.local.dashboard(path, STYLES.includes(style as CommandStyle) ? (style as CommandStyle) : undefined);
  }

  @Get('story')
  story(@Query('path') path: string, @Query('file') file: string) {
    return this.local.storyMarkdown(path, file);
  }

  @Post('spec/save')
  save(@Body() body: { path: string; spec: StorySpecInput & { updateSprintStatus?: boolean } }) {
    return this.local.saveSpec(body?.path, body?.spec);
  }

  @Get('fs')
  list(@Query('path') path?: string) {
    return this.local.listDir(path);
  }
}
