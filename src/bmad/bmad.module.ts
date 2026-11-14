import { Module } from '@nestjs/common';
import { AnalyzeController } from './analyze.controller';
import { EditController } from './edit.controller';
import { LocalController } from './local/local.controller';
import { LocalFsService } from './local/local-fs.service';

@Module({
  controllers: [AnalyzeController, EditController, LocalController],
  providers: [LocalFsService],
})
export class BmadModule {}
