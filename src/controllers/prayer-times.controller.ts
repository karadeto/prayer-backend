import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Logger,
    Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocationOutDto, NearestPrayerTimesResponseDto, PrayerTimesOutDto } from '../dto/prayer-times.dto';
import { IngestionService } from '../services/ingestion.service';
import { PrayerTimeService } from '../services/prayer-time.service';

@Controller('v1/prayer-times')
export class PrayerTimesController {
  private readonly logger = new Logger(PrayerTimesController.name);
  private readonly autoWarmupOnMiss: boolean;

  constructor(
    private readonly prayerTimeService: PrayerTimeService,
    private readonly ingestionService: IngestionService,
    private readonly configService: ConfigService,
  ) {
    this.autoWarmupOnMiss =
      this.configService.get('AUTO_WARMUP_ON_MISS', 'true') === 'true';
  }

  @Get('nearest')
  async nearest(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('target_date') targetDate?: string,
  ): Promise<NearestPrayerTimesResponseDto> {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      throw new HttpException('lat must be between -90 and 90', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      throw new HttpException('lng must be between -180 and 180', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const selectedDate =
      targetDate || new Date().toISOString().split('T')[0];

    const result = await this.prayerTimeService.byNearest(
      latNum,
      lngNum,
      selectedDate,
    );
    if (!result) {
      throw new HttpException('No locations loaded yet', HttpStatus.NOT_FOUND);
    }

    const { location, distanceM, prayerTime } = result;
    if (location.latitude == null || location.longitude == null) {
      throw new HttpException(
        'Nearest location has no coordinates',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const locationOut: LocationOutDto = {
      id: Number(location.id),
      diyanet_location_id: location.diyanetLocationId,
      display_name: location.displayName,
      country_name: location.countryName,
      city_name: location.cityName,
      district_name: location.districtName,
      latitude: location.latitude,
      longitude: location.longitude,
      distance_m: Math.round(distanceM * 100) / 100,
    };

    if (!prayerTime) {
      let cacheStatus: 'miss' | 'miss_warmup_started' = 'miss';
      if (this.autoWarmupOnMiss) {
        const year = parseInt(selectedDate.split('-')[0], 10);
        // Fire and forget
        this.ingestionService
          .warmupLocationYearById(Number(location.id), year)
          .catch((err) => this.logger.error(`Warmup failed for location ${location.id}, year ${year}: ${err.message}`));
        cacheStatus = 'miss_warmup_started';
      }

      return {
        date: selectedDate,
        location: locationOut,
        prayer_times: null,
        cache_status: cacheStatus,
      };
    }

    const prayerTimesOut: PrayerTimesOutDto = {
      date: prayerTime.prayerDate,
      fajr: prayerTime.fajr,
      sunrise: prayerTime.sunrise,
      dhuhr: prayerTime.dhuhr,
      asr: prayerTime.asr,
      maghrib: prayerTime.maghrib,
      isha: prayerTime.isha,
      scraped_at: prayerTime.scrapedAt,
    };

    return {
      date: selectedDate,
      location: locationOut,
      prayer_times: prayerTimesOut,
      cache_status: 'hit',
    };
  }
}
