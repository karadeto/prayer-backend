import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { IngestionService } from '../services/ingestion.service';

@Injectable()
export class SchedulerTask implements OnModuleInit {
  private readonly logger = new Logger(SchedulerTask.name);
  private readonly enabled: boolean;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly configService: ConfigService,
  ) {
    this.enabled =
      this.configService.get('SCHEDULER_ENABLED', 'true') === 'true';
  }

  onModuleInit() {
    if (this.enabled) {
      this.logger.log('Scheduler is enabled');
    } else {
      this.logger.log('Scheduler is disabled');
    }
  }

  @Cron('7 * * * *') // Every hour at minute 7
  async warmupCurrentYear() {
    if (!this.enabled) return;
    const year = new Date().getFullYear();
    this.logger.log(`Running warmup for current year ${year}`);
    try {
      const warmed = await this.ingestionService.warmupHotLocations(year);
      this.logger.log(`Warmed ${warmed} hot locations for year ${year}`);
    } catch (err) {
      this.logger.error('Warmup current year failed', err);
    }
  }

  @Cron('17 3 * * *') // Daily at 3:17
  async warmupNextYear() {
    if (!this.enabled) return;
    const now = new Date();
    if (now.getMonth() !== 11 || now.getDate() < 20) return; // December and day >= 20

    const nextYear = now.getFullYear() + 1;
    this.logger.log(`Running warmup for next year ${nextYear}`);
    try {
      const warmed = await this.ingestionService.warmupHotLocations(nextYear);
      this.logger.log(`Warmed ${warmed} hot locations for year ${nextYear}`);
    } catch (err) {
      this.logger.error('Warmup next year failed', err);
    }
  }
}
