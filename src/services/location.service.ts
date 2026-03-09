import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Location } from '../entities/location.entity';

// Map accented/umlaut characters to their ASCII equivalents so that
// e.g. "Tübingen" matches the DB value "TUBINGEN".
const UMLAUT_MAP: Record<string, string> = {
  ä: 'a', à: 'a', á: 'a', â: 'a', ã: 'a', å: 'a', æ: 'ae',
  ö: 'o', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ø: 'o',
  ü: 'u', ù: 'u', ú: 'u', û: 'u',
  ß: 'ss',
  ç: 'c', ć: 'c', č: 'c',
  ñ: 'n', ń: 'n',
  ę: 'e', è: 'e', é: 'e', ê: 'e', ë: 'e',
  ı: 'i', î: 'i', ï: 'i', ì: 'i', í: 'i',
  ğ: 'g', ś: 's', š: 's', ź: 'z', ż: 'z', ž: 'z',
  ł: 'l',
};

function deaccent(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\u0000-\u007E]/g, (ch) => UMLAUT_MAP[ch] ?? ch)
    .toLowerCase();
}

export interface NearestResult {
  location: Location;
  distanceM: number;
}

export interface SearchResult {
  location: Location;
  distanceM: number | null;
  matchType: 'exact' | 'prefix' | 'contains' | 'nearby';
}

@Injectable()
export class LocationService {
  constructor(
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
  ) {}

  private matchType(
    location: Location,
    normalizedQuery: string,
  ): 'exact' | 'prefix' | 'contains' {
    const values = [
      (location.displayName ?? '').trim().toLowerCase(),
      (location.cityName ?? '').trim().toLowerCase(),
      (location.districtName ?? '').trim().toLowerCase(),
      (location.countryName ?? '').trim().toLowerCase(),
    ].filter(Boolean);

    if (values.some((v) => v === normalizedQuery)) return 'exact';
    if (values.some((v) => v.startsWith(normalizedQuery))) return 'prefix';
    return 'contains';
  }

  async getNearest(lat: number, lng: number): Promise<NearestResult | null> {
    const result = await this.locationRepo
      .createQueryBuilder('l')
      .addSelect(
        `ST_DistanceSphere(l.geom, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326))`,
        'distance_m',
      )
      .where('l.is_active = true')
      .andWhere('l.geom IS NOT NULL')
      .orderBy('distance_m', 'ASC')
      .setParameters({ lat, lng })
      .limit(1)
      .getRawAndEntities();

    if (!result.raw.length) return null;

    const location = result.entities[0];
    const distanceM = parseFloat(result.raw[0].distance_m);
    return { location, distanceM };
  }

  async search(
    query: string,
    limit: number,
    lat?: number,
    lng?: number,
  ): Promise<SearchResult[]> {
    const normalized = deaccent(query.trim());
    if (!normalized) return [];

    const likeQuery = `%${normalized}%`;

    const qb = this.locationRepo
      .createQueryBuilder('l')
      .where('l.is_active = true')
      .andWhere(
        `(
          LOWER(COALESCE(l.display_name, '')) LIKE :likeQuery
          OR LOWER(COALESCE(l.city_name, '')) LIKE :likeQuery
          OR LOWER(COALESCE(l.district_name, '')) LIKE :likeQuery
          OR LOWER(COALESCE(l.country_name, '')) LIKE :likeQuery
          OR LOWER(COALESCE(l.slug, '')) LIKE :likeQuery
        )`,
      )
      .setParameters({ likeQuery })
      .addSelect(
        `CASE
          WHEN LOWER(COALESCE(l.display_name, '')) = :normalized THEN 0
          WHEN LOWER(COALESCE(l.city_name, '')) = :normalized THEN 0
          WHEN LOWER(COALESCE(l.district_name, '')) = :normalized THEN 0
          WHEN LOWER(COALESCE(l.country_name, '')) = :normalized THEN 0
          ELSE 1
        END`,
        'exact_rank',
      )
      .addSelect(
        `CASE
          WHEN LOWER(COALESCE(l.display_name, '')) LIKE :prefixQuery THEN 0
          WHEN LOWER(COALESCE(l.city_name, '')) LIKE :prefixQuery THEN 0
          WHEN LOWER(COALESCE(l.district_name, '')) LIKE :prefixQuery THEN 0
          WHEN LOWER(COALESCE(l.country_name, '')) LIKE :prefixQuery THEN 0
          ELSE 1
        END`,
        'prefix_rank',
      )
      .setParameters({
        normalized,
        prefixQuery: `${normalized}%`,
      });

    if (lat != null && lng != null) {
      qb.andWhere('l.geom IS NOT NULL')
        .addSelect(
          `ST_DistanceSphere(l.geom, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326))`,
          'distance_m',
        )
        .setParameters({ lat, lng })
        .orderBy('exact_rank', 'ASC')
        .addOrderBy('prefix_rank', 'ASC')
        .addOrderBy('distance_m', 'ASC')
        .addOrderBy('l.display_name', 'ASC');
    } else {
      qb.orderBy('exact_rank', 'ASC')
        .addOrderBy('prefix_rank', 'ASC')
        .addOrderBy('l.display_name', 'ASC');
    }

    qb.limit(limit);

    const rawAndEntities = await qb.getRawAndEntities();

    return rawAndEntities.entities.map((location, idx) => ({
      location,
      distanceM: rawAndEntities.raw[idx].distance_m
        ? parseFloat(rawAndEntities.raw[idx].distance_m)
        : null,
      matchType: this.matchType(location, normalized),
    }));
  }
}
