import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './modules/prisma/prisma.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { DatasetsModule } from './modules/datasets/datasets.module.js';
import { AnalysesModule } from './modules/analyses/analyses.module.js';
import { PublicModule } from './modules/public/public.module.js';
import { HarmonizerModule } from './modules/harmonizer/harmonizer.module.js';
import { ApiDuckDbModule } from './modules/analysis/api-duckdb.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ApiDuckDbModule,
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    DatasetsModule,
    AnalysesModule,
    PublicModule,
    HarmonizerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
