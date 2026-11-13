import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { SupabaseService } from '../supabase/supabase.service';

@Module({
  controllers: [ProjectsController],
  providers: [SupabaseService],
})
export class ProjectsModule {}
