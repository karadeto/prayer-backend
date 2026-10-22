import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LocationOutDto,
  MonthPrayerTimesResponseDto,
  NearestPrayerTimesResponseDto,
  PrayerTimesOutDto,
} from '../dto/prayer-times.dto';
import { Location } from '../entities/location.entity';
import { PrayerTime } from '../entities/prayer-time.entity';
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
    const { latNum, lngNum } = this.parseCoordinates(lat, lng);

    const selectedDate = targetDate || new Date().toISOString().split('T')[0];

    const result = await this.prayerTimeService.byNearest(
      latNum,
      lngNum,
      selectedDate,
    );
    if (!result) {
      throw new HttpException('No locations loaded yet', HttpStatus.NOT_FOUND);
    }

    const { location, distanceM, prayerTime } = result;
    const locationOut = this.toLocationOut(location, distanceM);

    if (!prayerTime) {
      let cacheStatus: 'miss' | 'miss_warmup_started' = 'miss';
      if (this.autoWarmupOnMiss) {
        const year = parseInt(selectedDate.split('-')[0], 10);
        // Fire and forget
        this.ingestionService
          .warmupLocationYearById(Number(location.id), year)
          .catch((err) =>
            this.logger.error(
              `Warmup failed for location ${location.id}, year ${year}: ${err.message}`,
            ),
          );
        cacheStatus = 'miss_warmup_started';
      }

      return {
        date: selectedDate,
        location: locationOut,
        prayer_times: null,
        cache_status: cacheStatus,
      };
    }

    return {
      date: selectedDate,
      location: locationOut,
      prayer_times: this.toPrayerTimesOut(prayerTime),
      cache_status: 'hit',
    };
  }

  /** Every day of a month (defaults to the current UTC month) for the nearest location. */
  @Get('month')
  async month(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ): Promise<MonthPrayerTimesResponseDto> {
    const { latNum, lngNum } = this.parseCoordinates(lat, lng);

    const now = new Date();
    const yearNum = year ? parseInt(year, 10) : now.getUTCFullYear();
    const monthNum = month ? parseInt(month, 10) : now.getUTCMonth() + 1;
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new HttpException(
        'year must be between 2000 and 2100',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
      throw new HttpException(
        'month must be between 1 and 12',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const result = await this.prayerTimeService.monthByNearest(
      latNum,
      lngNum,
      yearNum,
      monthNum,
    );
    if (!result) {
      throw new HttpException('No locations loaded yet', HttpStatus.NOT_FOUND);
    }

    const { location, distanceM, prayerTimes } = result;
    const daysInMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();

    let cacheStatus: MonthPrayerTimesResponseDto['cache_status'] = 'hit';
    if (prayerTimes.length < daysInMonth) {
      cacheStatus = 'partial';
      if (this.autoWarmupOnMiss) {
        // Fire and forget, like the daily endpoint.
        this.ingestionService
          .warmupLocationYearById(Number(location.id), yearNum)
          .catch((err) =>
            this.logger.error(
              `Warmup failed for location ${location.id}, year ${yearNum}: ${err.message}`,
            ),
          );
        cacheStatus = 'miss_warmup_started';
      }
    }

    return {
      year: yearNum,
      month: monthNum,
      days_in_month: daysInMonth,
      location: this.toLocationOut(location, distanceM),
      days: prayerTimes.map((p) => this.toPrayerTimesOut(p)),
      cache_status: cacheStatus,
    };
  }

  private parseCoordinates(
    lat: string,
    lng: string,
  ): { latNum: number; lngNum: number } {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      throw new HttpException(
        'lat must be between -90 and 90',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      throw new HttpException(
        'lng must be between -180 and 180',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return { latNum, lngNum };
  }

  private toLocationOut(location: Location, distanceM: number): LocationOutDto {
    if (location.latitude == null || location.longitude == null) {
      throw new HttpException(
        'Nearest location has no coordinates',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return {
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
  }

  private toPrayerTimesOut(prayerTime: PrayerTime): PrayerTimesOutDto {
    return {
      date: prayerTime.prayerDate,
      fajr: prayerTime.fajr,
      sunrise: prayerTime.sunrise,
      dhuhr: prayerTime.dhuhr,
      asr: prayerTime.asr,
      maghrib: prayerTime.maghrib,
      isha: prayerTime.isha,
      scraped_at: prayerTime.scrapedAt,
    };
  }
}
