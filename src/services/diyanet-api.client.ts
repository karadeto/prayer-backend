import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface ApiPrayerDay {
  prayerDate: string;
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
}

interface EzanvaktiResponse {
  data: EzanvaktiEntry[];
  meta: { totalCount: number };
}

interface EzanvaktiEntry {
  date: string;
  times: {
    imsak: string;
    gunes: string;
    ogle: string;
    ikindi: string;
    aksam: string;
    yatsi: string;
  };
}

@Injectable()
export class DiyanetApiClient {
  private readonly logger = new Logger(DiyanetApiClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get(
      'DIYANET_API_BASE_URL',
      'https://ezanvakti.imsakiyem.com',
    );
    this.timeoutMs =
      +(this.configService.get('DIYANET_API_TIMEOUT_SECONDS', '30')) * 1000;
  }

  async fetchYearlyPrayerTimes(diyanetLocationId: number): Promise<ApiPrayerDay[]> {
    const url = `${this.baseUrl}/api/prayer-times/${diyanetLocationId}/yearly`;

    this.logger.log(`Fetching yearly prayer times from ${url}`);

    const response = await axios.get<EzanvaktiResponse>(url, {
      timeout: this.timeoutMs,
      headers: { Accept: 'application/json' },
    });

    const entries = response.data?.data ?? [];
    if (!entries.length) {
      throw new Error(
        `No prayer times returned for location ${diyanetLocationId}`,
      );
    }

    this.logger.log(
      `Received ${entries.length} days for location ${diyanetLocationId}`,
    );

    return entries.map((entry) => ({
      prayerDate: entry.date.split('T')[0],
      fajr: entry.times.imsak,
      sunrise: entry.times.gunes,
      dhuhr: entry.times.ogle,
      asr: entry.times.ikindi,
      maghrib: entry.times.aksam,
      isha: entry.times.yatsi,
    }));
  }
}
