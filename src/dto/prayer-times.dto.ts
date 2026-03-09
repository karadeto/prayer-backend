export class LocationOutDto {
  id!: number;
  diyanet_location_id!: number;
  display_name!: string;
  country_name?: string | null;
  city_name?: string | null;
  district_name?: string | null;
  latitude!: number;
  longitude!: number;
  distance_m!: number;
}

export class LocationSearchItemDto {
  id!: number;
  diyanet_location_id!: number;
  display_name!: string;
  country_name?: string | null;
  city_name?: string | null;
  district_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  distance_m?: number | null;
  match_type!: 'exact' | 'prefix' | 'contains' | 'nearby';
}

export class LocationSearchResponseDto {
  query!: string;
  total!: number;
  results!: LocationSearchItemDto[];
}

export class PrayerTimesOutDto {
  date!: string;
  fajr!: string;
  sunrise!: string;
  dhuhr!: string;
  asr!: string;
  maghrib!: string;
  isha!: string;
  scraped_at!: Date;
}

export class NearestPrayerTimesResponseDto {
  date!: string;
  location!: LocationOutDto;
  prayer_times?: PrayerTimesOutDto | null;
  cache_status!: 'hit' | 'miss' | 'miss_warmup_started';
}

export class CrawlLocationsSummaryDto {
  discovered!: number;
  processed!: number;
  inserted!: number;
  updated!: number;
  skipped!: number;
  errors!: number;
}

export class WarmupSummaryDto {
  location_id!: number;
  diyanet_location_id!: number;
  requested_year!: number;
  parsed_year!: number;
  upserted_days!: number;
}

export class CrawlSingleLocationSummaryDto {
  location_id!: number;
  diyanet_location_id!: number;
  display_name!: string;
  country_name?: string | null;
  city_name?: string | null;
  district_name?: string | null;
  created!: boolean;
}

export class SeedIdRangeSummaryDto {
  start_id!: number;
  end_id!: number;
  attempted!: number;
  resolved!: number;
  processed!: number;
  inserted!: number;
  updated!: number;
  skipped!: number;
  errors!: number;
  blocked_http!: number;
  blocked_transport!: number;
  stopped_early!: boolean;
  stop_reason?: string | null;
  status_counts!: Record<string, number>;
  sample_errors!: string[];
  locale!: string;
}

export class SeedHierarchySummaryDto {
  locale!: string;
  mode!: 'full' | 'ids_only';
  countries_total!: number;
  countries_selected!: number;
  states_total!: number;
  locations_total!: number;
  processed!: number;
  inserted!: number;
  updated!: number;
  skipped!: number;
  errors!: number;
  blocked_http!: number;
  blocked_transport!: number;
  status_counts!: Record<string, number>;
  sample_errors!: string[];
}

export class GeocodeMissingSummaryDto {
  scanned!: number;
  updated!: number;
  unresolved!: number;
  errors!: number;
  next_start_after_id?: number | null;
}

export class GeocodeSingleSummaryDto {
  location_id!: number;
  diyanet_location_id!: number;
  updated!: boolean;
  unresolved!: boolean;
  latitude?: number | null;
  longitude?: number | null;
}
