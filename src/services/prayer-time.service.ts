import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Location } from '../entities/location.entity';
import { PrayerTime } from '../entities/prayer-time.entity';
import { LocationService, NearestResult } from './location.service';

export interface NearestPrayerTimeResult {
  location: Location;
  distanceM: number;
  prayerTime: PrayerTime | null;
}

export interface NearestPrayerMonthResult {
  location: Location;
  distanceM: number;
  prayerTimes: PrayerTime[];
}

@Injectable()
export class PrayerTimeService {
  constructor(
    @InjectRepository(PrayerTime)
    private readonly prayerTimeRepo: Repository<PrayerTime>,
    private readonly locationService: LocationService,
  ) {}

  async byNearest(
    lat: number,
    lng: number,
    prayerDate: string,
  ): Promise<NearestPrayerTimeResult | null> {
    const nearest: NearestResult | null = await this.locationService.getNearest(
      lat,
      lng,
    );
    if (!nearest) return null;

    const { location, distanceM } = nearest;
    const prayerTime = await this.prayerTimeRepo.findOne({
      where: {
        locationId: location.id,
        prayerDate,
      },
    });

    return { location, distanceM, prayerTime };
  }

  /** All stored days of `year`-`month` (1-12) for the nearest location, in date order. */
  async monthByNearest(
    lat: number,
    lng: number,
    year: number,
    month: number,
  ): Promise<NearestPrayerMonthResult | null> {
    const nearest: NearestResult | null = await this.locationService.getNearest(
      lat,
      lng,
    );
    if (!nearest) return null;

    const { location, distanceM } = nearest;
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const prayerTimes = await this.prayerTimeRepo.find({
      where: {
        locationId: location.id,
        prayerDate: Between(
          `${year}-${pad(month)}-01`,
          `${year}-${pad(month)}-${pad(lastDay)}`,
        ),
      },
      order: { prayerDate: 'ASC' },
    });

    return { location, distanceM, prayerTimes };
  }
}
