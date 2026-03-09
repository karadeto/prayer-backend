import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Location } from './entities/location.entity';
import { PrayerTime } from './entities/prayer-time.entity';

import { DiyanetApiClient } from './services/diyanet-api.client';
import { IngestionService } from './services/ingestion.service';
import { LocationService } from './services/location.service';
import { PrayerTimeService } from './services/prayer-time.service';

import { AdminController } from './controllers/admin.controller';
import { HealthController } from './controllers/health.controller';
import { LocationsController } from './controllers/locations.controller';
import { PrayerTimesController } from './controllers/prayer-times.controller';

import { SchedulerTask } from './tasks/scheduler.task';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url =
          config.get<string>('DATABASE_URL') ??
          'postgresql://postgres:postgres@localhost:5432/prayer_api';
        return {
          type: 'postgres' as const,
          url,
          entities: [Location, PrayerTime],
          synchronize: true,
        };
      },
    }),
    TypeOrmModule.forFeature([Location, PrayerTime]),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    HealthController,
    LocationsController,
    PrayerTimesController,
    AdminController,
  ],
  providers: [
    DiyanetApiClient,
    LocationService,
    PrayerTimeService,
    IngestionService,
    SchedulerTask,
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    try {
      await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS postgis');
      this.logger.log('PostGIS extension ensured');
    } catch (err) {
      this.logger.warn('Could not create PostGIS extension', err);
    }

    try {
      await this.dataSource.query(
        'ALTER TABLE IF EXISTS locations ALTER COLUMN latitude DROP NOT NULL',
      );
      await this.dataSource.query(
        'ALTER TABLE IF EXISTS locations ALTER COLUMN longitude DROP NOT NULL',
      );
      await this.dataSource.query(
        'ALTER TABLE IF EXISTS locations ALTER COLUMN geom DROP NOT NULL',
      );
    } catch {
      // Columns may already be nullable
    }
  }
}
