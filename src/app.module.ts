import { Module } from '@nestjs/common';
import { BmadModule } from './bmad/bmad.module';
import { ProjectsModule } from './projects/projects.module';
import { ConfigController } from './config.controller';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [BmadModule, ProjectsModule, AiModule],
  controllers: [ConfigController],
})
export class AppModule {}
