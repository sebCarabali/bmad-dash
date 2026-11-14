import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ConversationsController } from './conversations.controller';
import { SupabaseService } from '../supabase/supabase.service';

@Module({
  controllers: [ProjectsController, ConversationsController],
  providers: [SupabaseService],
})
export class ProjectsModule {}
