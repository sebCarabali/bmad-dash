import { Controller, Get } from '@nestjs/common';
import { isLocalMode } from './app.setup';
import { supabaseConfig } from './supabase/supabase.service';
import { groqServerKey } from './ai/ai.controller';
import { CONFIG_FILES, IGNORED_DIRS, METHOD_DIRS, MAX_FILE_SIZE } from './bmad/core/analyzer';

/** Configuración pública que necesita el frontend (la clave publishable es pública por diseño). */
@Controller('config')
export class ConfigController {
  @Get()
  get() {
    const sb = supabaseConfig();
    return {
      localMode: isLocalMode(),
      supabase: sb.url && sb.key ? { url: sb.url, key: sb.key } : null,
      // Solo se indica si existe; el valor de la key nunca se envía al navegador
      ai: { groqServerKey: !!groqServerKey() },
      scan: { ignoredDirs: IGNORED_DIRS, methodDirs: METHOD_DIRS, configFiles: CONFIG_FILES, maxFileSize: MAX_FILE_SIZE, maxDepth: 8 },
    };
  }
}
