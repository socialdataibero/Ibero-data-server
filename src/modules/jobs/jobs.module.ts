import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

/** Producer side of the background jobs. Import it where a module needs to add jobs. */
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
