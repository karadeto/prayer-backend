import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Location } from '../entities/location.entity';
import { PrayerTime } from '../entities/prayer-time.entity';
import { LocationService, NearestResult } from './location.service';

export interface NearestPrayerTimeResult {
  location: Location;
  distanceM: number;
  prayerTime: PrayerTime | null;
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
}
