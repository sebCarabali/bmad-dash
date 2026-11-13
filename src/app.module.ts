import { Module } from '@nestjs/common';
import { BmadModule } from './bmad/bmad.module';
import { ProjectsModule } from './projects/projects.module';
import { ConfigController } from './config.controller';

@Module({
  imports: [BmadModule, ProjectsModule],
  controllers: [ConfigController],
})
export class AppModule {}
