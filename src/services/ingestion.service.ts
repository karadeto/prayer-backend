import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
    AppConfig,
    getAllowedCountryKeywords,
} from '../core/config';
import { normalizeLookup } from '../core/text-utils';
import { CrawlerSourceError, DiyanetCrawlerClient } from '../crawler/diyanet-client';
import {
    ParsedLocation,
    ParsedRegItem,
    parseLocationMetadata,
    parseRegListItems,
    parseSelectItems
} from '../crawler/parsers';
import { Location } from '../entities/location.entity';
import { PrayerTime } from '../entities/prayer-time.entity';
import { DiyanetApiClient } from './diyanet-api.client';
import { GeocodeResult, GeocoderService } from './geocoder.service';

export class YearUnavailableError extends Error {}

const SLUG_PARTS_RE = /[^a-z0-9]+/g;

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly config: AppConfig;
  private readonly allowedKeywords: string[];

  constructor(
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    @InjectRepository(PrayerTime)
    private readonly prayerTimeRepo: Repository<PrayerTime>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly diyanetApi: DiyanetApiClient,
  ) {
    this.config = {
      appName: this.configService.get('APP_NAME', 'Prayer API'),
      appVersion: this.configService.get('APP_VERSION', '0.1.0'),
      environment: this.configService.get('ENVIRONMENT', 'dev'),
      debug: this.configService.get('DEBUG') === 'true',
      databaseUrl: this.configService.get('DATABASE_URL', ''),
      crawlerBaseUrl: this.configService.get(
        'CRAWLER_BASE_URL',
        'https://namazvakitleri.diyanet.gov.tr',
      ),
      crawlerSitemapIndexPathsCsv: this.configService.get(
        'CRAWLER_SITEMAP_INDEX_PATHS_CSV',
        '/sitemap.xml',
      ),
      crawlerTimeoutSeconds: +(this.configService.get('CRAWLER_TIMEOUT_SECONDS', '30')),
      crawlerUserAgent: this.configService.get(
        'CRAWLER_USER_AGENT',
        'prayer-api/0.1',
      ),
      crawlerConcurrency: +(this.configService.get('CRAWLER_CONCURRENCY', '5')),
      geocoderEnabled:
        this.configService.get('GEOCODER_ENABLED', 'true') === 'true',
      googleGeocodingApiKey: this.configService.get('GOOGLE_GEOCODING_API_KEY', ''),
      geocoderTimeoutSeconds: +(this.configService.get('GEOCODER_TIMEOUT_SECONDS', '20')),
      geocoderMinConfidence: +(this.configService.get('GEOCODER_MIN_CONFIDENCE', '0.5')),
      geocodeDebugLogs:
        this.configService.get('GEOCODE_DEBUG_LOGS') === 'true',
      geocodeProgressEvery: +(this.configService.get('GEOCODE_PROGRESS_EVERY', '50')),
      seedProbeTimeoutSeconds: +(this.configService.get('SEED_PROBE_TIMEOUT_SECONDS', '6')),
      seedMaxBlockedStreak: +(this.configService.get('SEED_MAX_BLOCKED_STREAK', '5')),
      seedLocationFetchConcurrency: +(this.configService.get('SEED_LOCATION_FETCH_CONCURRENCY', '10')),
      seedLocationFetchRetries: +(this.configService.get('SEED_LOCATION_FETCH_RETRIES', '2')),
      schedulerEnabled:
        this.configService.get('SCHEDULER_ENABLED', 'true') === 'true',
      autoWarmupOnMiss:
        this.configService.get('AUTO_WARMUP_ON_MISS', 'true') === 'true',
      allowedCountryKeywordsCsv: this.configService.get(
        'ALLOWED_COUNTRY_KEYWORDS_CSV',
        'turkiye,turkey,almanya,germany',
      ),
      hotLocationsLimit: +(this.configService.get('HOT_LOCATIONS_LIMIT', '200')),
    };
    this.allowedKeywords = getAllowedCountryKeywords(
      this.config.allowedCountryKeywordsCsv,
    );
  }

  private isAllowedCountry(countryName: string | null): boolean {
    if (!countryName) return true;
    const normalized = normalizeLookup(countryName);
    return this.allowedKeywords.some((kw) => normalized.includes(kw));
  }

  private buildSlug(name: string, fallbackId: number): string {
    const normalized = normalizeLookup(name);
    const slug = normalized.replace(SLUG_PARTS_RE, '-').replace(/^-+|-+$/g, '');
    if (!slug) return `location-${fallbackId}`;
    return `${slug}-icin-namaz-vakti`;
  }

  private setLocationCoordinates(
    location: Location,
    latitude: number,
    longitude: number,
  ): void {
    location.latitude = latitude;
    location.longitude = longitude;
    location.geom = () =>
      `ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)` as unknown as object;
  }

  private async upsertLocation(
    parsed: ParsedLocation,
  ): Promise<{ location: Location; created: boolean }> {
    let location = await this.locationRepo.findOne({
      where: { diyanetLocationId: parsed.diyanetLocationId },
    });
    const created = !location;

    if (created) {
      location = this.locationRepo.create({
        diyanetLocationId: parsed.diyanetLocationId,
        locale: parsed.locale,
        slug: parsed.slug,
        displayName: parsed.displayName,
        countryName: parsed.countryName,
        cityName: parsed.cityName,
        districtName: parsed.districtName,
        sourceUrl: parsed.sourceUrl,
      });
    } else {
      location!.locale = parsed.locale;
      location!.slug = parsed.slug;
      location!.displayName = parsed.displayName;
      location!.countryName = parsed.countryName ?? location!.countryName;
      location!.cityName = parsed.cityName ?? location!.cityName;
      location!.districtName = parsed.districtName ?? location!.districtName;
      location!.sourceUrl = parsed.sourceUrl;
    }

    if (parsed.latitude != null && parsed.longitude != null) {
      location!.latitude = parsed.latitude;
      location!.longitude = parsed.longitude;
      // Use raw query to set geometry
      await this.locationRepo.save(location!);
      await this.dataSource.query(
        `UPDATE locations SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
        [parsed.longitude, parsed.latitude, location!.id],
      );
      return { location: location!, created };
    }

    await this.locationRepo.save(location!);
    return { location: location!, created };
  }

  private async upsertPrayerTimes(
    locationId: number,
    sourceUrl: string,
    rows: {
      prayerDate: string;
      fajr: string;
      sunrise: string;
      dhuhr: string;
      asr: string;
      maghrib: string;
      isha: string;
    }[],
  ): Promise<number> {
    if (!rows.length) return 0;

    for (const row of rows) {
      const year = parseInt(row.prayerDate.split('-')[0], 10);
      await this.dataSource.query(
        `INSERT INTO prayer_times (location_id, prayer_date, year, fajr, sunrise, dhuhr, asr, maghrib, isha, source_url, scraped_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (location_id, prayer_date)
         DO UPDATE SET year = EXCLUDED.year, fajr = EXCLUDED.fajr, sunrise = EXCLUDED.sunrise,
           dhuhr = EXCLUDED.dhuhr, asr = EXCLUDED.asr, maghrib = EXCLUDED.maghrib,
           isha = EXCLUDED.isha, source_url = EXCLUDED.source_url, scraped_at = NOW()`,
        [
          locationId,
          row.prayerDate,
          year,
          row.fajr,
          row.sunrise,
          row.dhuhr,
          row.asr,
          row.maghrib,
          row.isha,
          sourceUrl,
        ],
      );
    }

    return rows.length;
  }

  private async ensureCoordinates(
    parsed: ParsedLocation,
    geocoder: GeocoderService | null,
    manualLat?: number,
    manualLng?: number,
  ): Promise<GeocodeResult | null> {
    if ((manualLat == null) !== (manualLng == null)) {
      throw new Error('Both lat and lng must be provided together');
    }
    if (manualLat != null && manualLng != null) {
      parsed.latitude = manualLat;
      parsed.longitude = manualLng;
      return null;
    }
    if (parsed.latitude != null && parsed.longitude != null) return null;
    if (!geocoder) return null;

    const result = await geocoder.geocodeLocation(parsed);
    if (!result) return null;
    parsed.latitude = result.lat;
    parsed.longitude = result.lng;
    return result;
  }

  async crawlLocationsFromSitemap(
    limit?: number,
  ): Promise<Record<string, number>> {
    let discovered = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const crawler = new DiyanetCrawlerClient(this.config);
    const geocoder = this.config.geocoderEnabled
      ? new GeocoderService(this.config)
      : null;

    let urls = await crawler.fetchLocationUrls();
    discovered = urls.length;
    if (limit) urls = urls.slice(0, limit);

    for (let i = 0; i < urls.length; i++) {
      try {
        const html = await crawler.fetchText(urls[i]);
        const parsed = parseLocationMetadata(html, urls[i]);
        await this.ensureCoordinates(parsed, geocoder);

        if (!this.isAllowedCountry(parsed.countryName)) {
          skipped++;
          continue;
        }

        const { created } = await this.upsertLocation(parsed);
        if (created) inserted++;
        else updated++;
        processed++;
      } catch {
        errors++;
      }
    }

    return { discovered, processed, inserted, updated, skipped, errors };
  }

  async crawlSingleLocationByUrl(
    url: string,
    manualLat?: number,
    manualLng?: number,
  ): Promise<Record<string, unknown>> {
    const crawler = new DiyanetCrawlerClient(this.config);
    const geocoder = this.config.geocoderEnabled
      ? new GeocoderService(this.config)
      : null;

    let html: string;
    let parsed: ParsedLocation;
    try {
      html = await crawler.fetchText(url);
      parsed = parseLocationMetadata(html, url);
    } catch (exc) {
      throw new CrawlerSourceError(
        `Failed to load location URL from source: ${exc}`,
      );
    }

    await this.ensureCoordinates(parsed, geocoder, manualLat, manualLng);

    if (!this.isAllowedCountry(parsed.countryName)) {
      throw new Error(
        `Country not allowed by current filter: ${parsed.countryName ?? 'unknown'}`,
      );
    }

    const { location, created } = await this.upsertLocation(parsed);

    return {
      location_id: Number(location.id),
      diyanet_location_id: location.diyanetLocationId,
      display_name: location.displayName,
      country_name: location.countryName,
      city_name: location.cityName,
      district_name: location.districtName,
      created,
    };
  }

  async seedLocationsByIdRange(params: {
    startId: number;
    endId: number;
    locale?: string;
    maxSuccess?: number;
    probeTimeoutSeconds?: number;
    maxBlockedStreak?: number;
    geocodeMissing?: boolean;
  }): Promise<Record<string, unknown>> {
    let attempted = 0;
    let resolved = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let blockedHttp = 0;
    let blockedTransport = 0;
    let blockedStreak = 0;
    let stoppedEarly = false;
    let stopReason: string | null = null;
    const statusCounts: Record<string, number> = {};
    const sampleErrors: string[] = [];

    const baseUrl = this.config.crawlerBaseUrl.replace(/\/+$/, '');
    const locale = (params.locale ?? 'tr-TR').trim() || 'tr-TR';
    const idStart = Math.min(params.startId, params.endId);
    const idEnd = Math.max(params.startId, params.endId);
    const requestTimeout =
      params.probeTimeoutSeconds && params.probeTimeoutSeconds > 0
        ? params.probeTimeoutSeconds
        : this.config.seedProbeTimeoutSeconds;
    const maxBlocked =
      params.maxBlockedStreak && params.maxBlockedStreak > 0
        ? params.maxBlockedStreak
        : this.config.seedMaxBlockedStreak;

    const crawler = new DiyanetCrawlerClient(this.config);
    const geocoder =
      this.config.geocoderEnabled && params.geocodeMissing
        ? new GeocoderService(this.config)
        : null;

    for (let diyanetId = idStart; diyanetId <= idEnd; diyanetId++) {
      if (params.maxSuccess != null && processed >= params.maxSuccess) break;

      attempted++;
      const probeUrl = `${baseUrl}/${locale}/${diyanetId}`;

      let html: string;
      let finalUrl: string;
      let statusCode: number;
      try {
        const result = await crawler.fetchPageOnce(probeUrl, requestTimeout);
        html = result.html;
        finalUrl = result.finalUrl;
        statusCode = result.statusCode;
      } catch (err) {
        errors++;
        blockedTransport++;
        blockedStreak++;
        if (sampleErrors.length < 10) {
          sampleErrors.push(
            `${probeUrl} -> ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (blockedStreak >= maxBlocked) {
          stoppedEarly = true;
          stopReason = `Stopped after ${blockedStreak} consecutive transport errors`;
          break;
        }
        continue;
      }

      if (statusCode >= 400) {
        const key = String(statusCode);
        statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        if (statusCode === 404 || statusCode === 410) {
          skipped++;
          blockedStreak = 0;
          continue;
        }
        if ([401, 403, 429, 500, 502, 503, 504].includes(statusCode)) {
          blockedHttp++;
          skipped++;
          blockedStreak++;
          if (blockedStreak >= maxBlocked) {
            stoppedEarly = true;
            stopReason = `Stopped after ${blockedStreak} consecutive blocked responses (HTTP ${statusCode})`;
            break;
          }
          continue;
        }
        errors++;
        blockedStreak = 0;
        continue;
      }

      resolved++;
      blockedStreak = 0;

      let parsed: ParsedLocation;
      try {
        parsed = parseLocationMetadata(html, finalUrl);
      } catch {
        try {
          parsed = parseLocationMetadata(html, probeUrl);
        } catch {
          skipped++;
          continue;
        }
      }

      await this.ensureCoordinates(parsed, geocoder);

      if (!this.isAllowedCountry(parsed.countryName)) {
        skipped++;
        continue;
      }

      const { created } = await this.upsertLocation(parsed);
      if (created) inserted++;
      else updated++;
      processed++;
    }

    return {
      start_id: idStart,
      end_id: idEnd,
      attempted,
      resolved,
      processed,
      inserted,
      updated,
      skipped,
      errors,
      blocked_http: blockedHttp,
      blocked_transport: blockedTransport,
      stopped_early: stoppedEarly,
      stop_reason: stopReason,
      status_counts: statusCounts,
      sample_errors: sampleErrors,
      locale,
    };
  }

  async seedLocationsFromHierarchy(params: {
    locale?: string;
    geocodeMissing?: boolean;
    skipLocationPages?: boolean;
    countryId?: number;
    maxCountries?: number;
    maxStatesPerCountry?: number;
    maxLocationsPerState?: number;
    probeTimeoutSeconds?: number;
    requestDelaySeconds?: number;
    locationFetchConcurrency?: number;
    locationFetchRetries?: number;
  }): Promise<Record<string, unknown>> {
    let countriesTotal = 0;
    let countriesSelected = 0;
    let statesTotal = 0;
    let locationsTotal = 0;
    let processed = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let blockedHttp = 0;
    let blockedTransport = 0;
    const statusCounts: Record<string, number> = {};
    const sampleErrors: string[] = [];

    const baseUrl = this.config.crawlerBaseUrl.replace(/\/+$/, '');
    const locale = (params.locale ?? 'tr-TR').trim() || 'tr-TR';
    const mode = params.skipLocationPages ? 'ids_only' : 'full';
    const requestTimeout =
      params.probeTimeoutSeconds && params.probeTimeoutSeconds > 0
        ? params.probeTimeoutSeconds
        : this.config.seedProbeTimeoutSeconds;
    const fetchRetries =
      params.locationFetchRetries && params.locationFetchRetries > 0
        ? params.locationFetchRetries
        : this.config.seedLocationFetchRetries;

    const crawler = new DiyanetCrawlerClient(this.config);
    const geocoder =
      this.config.geocoderEnabled && params.geocodeMissing
        ? new GeocoderService(this.config)
        : null;

    const addError = (message: string) => {
      errors++;
      if (sampleErrors.length < 10) sampleErrors.push(message);
    };

    let homeHtml: string;
    try {
      homeHtml = await crawler.fetchText(`${baseUrl}/${locale}`);
    } catch (exc) {
      throw new CrawlerSourceError(
        `Failed to load Diyanet home page: ${exc}`,
      );
    }

    const countries = parseSelectItems(homeHtml, [
      'CountryId',
      'countryId',
      'country',
    ]);
    countriesTotal = countries.length;

    let selectedCountries: ParsedRegItem[];
    if (params.countryId != null) {
      selectedCountries = countries.filter(
        (c) => c.itemId === params.countryId,
      );
    } else {
      selectedCountries = countries.filter((c) =>
        this.isAllowedCountry(c.name),
      );
    }
    if (params.maxCountries != null) {
      selectedCountries = selectedCountries.slice(0, params.maxCountries);
    }
    countriesSelected = selectedCountries.length;

    for (const country of selectedCountries) {
      const countryUrl = `${baseUrl}/${locale}/home/GetRegList?ChangeType=country&CountryId=${country.itemId}&Culture=${locale}`;
      let stateItems: ParsedRegItem[];
      try {
        const payload = await crawler.fetchText(countryUrl);
        stateItems = parseRegListItems(payload);
      } catch (exc) {
        addError(`${countryUrl} -> ${exc}`);
        continue;
      }

      if (params.maxStatesPerCountry != null) {
        stateItems = stateItems.slice(0, params.maxStatesPerCountry);
      }
      statesTotal += stateItems.length;

      for (const state of stateItems) {
        const stateUrl = `${baseUrl}/${locale}/home/GetRegList?ChangeType=state&CountryId=${country.itemId}&Culture=${locale}&StateId=${state.itemId}`;
        let locationItems: ParsedRegItem[];
        try {
          const payload = await crawler.fetchText(stateUrl);
          locationItems = parseRegListItems(payload);
        } catch (exc) {
          addError(`${stateUrl} -> ${exc}`);
          continue;
        }

        if (params.maxLocationsPerState != null) {
          locationItems = locationItems.slice(0, params.maxLocationsPerState);
        }
        locationsTotal += locationItems.length;

        if (params.skipLocationPages) {
          for (const locationItem of locationItems) {
            const slug = this.buildSlug(locationItem.name, locationItem.itemId);
            const parsed: ParsedLocation = {
              diyanetLocationId: locationItem.itemId,
              locale,
              slug,
              displayName: locationItem.name,
              countryName: country.name,
              cityName: locationItem.name,
              districtName: state.name,
              latitude: null,
              longitude: null,
              sourceUrl: `${baseUrl}/${locale}/${locationItem.itemId}`,
            };
            await this.ensureCoordinates(parsed, geocoder);

            if (!this.isAllowedCountry(parsed.countryName)) {
              skipped++;
              continue;
            }

            const { created } = await this.upsertLocation(parsed);
            if (created) inserted++;
            else updated++;
            processed++;
          }
          continue;
        }

        // Fetch location pages
        for (const locationItem of locationItems) {
          const locationUrl = `${baseUrl}/${locale}/${locationItem.itemId}`;
          let html: string | null = null;
          let finalUrl: string | null = null;
          let statusCode: number | null = null;
          let fetchError: unknown = null;

          for (let attempt = 1; attempt <= fetchRetries; attempt++) {
            if (params.requestDelaySeconds && params.requestDelaySeconds > 0) {
              await new Promise((r) =>
                setTimeout(r, params.requestDelaySeconds! * 1000),
              );
            }
            try {
              const result = await crawler.fetchPageOnce(
                locationUrl,
                requestTimeout,
              );
              html = result.html;
              finalUrl = result.finalUrl;
              statusCode = result.statusCode;

              if (
                [429, 500, 502, 503, 504].includes(statusCode) &&
                attempt < fetchRetries
              ) {
                await new Promise((r) =>
                  setTimeout(r, Math.min(1500, 200 * attempt)),
                );
                continue;
              }
              fetchError = null;
              break;
            } catch (err) {
              fetchError = err;
              if (attempt < fetchRetries) {
                await new Promise((r) =>
                  setTimeout(r, Math.min(1500, 200 * attempt)),
                );
              }
            }
          }

          if (fetchError) {
            blockedTransport++;
            addError(
              `${locationUrl} -> ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
            );
            continue;
          }

          if (statusCode != null && statusCode >= 400) {
            const key = String(statusCode);
            statusCounts[key] = (statusCounts[key] ?? 0) + 1;
            skipped++;
            if ([401, 403, 429, 500, 502, 503, 504].includes(statusCode)) {
              blockedHttp++;
            }
            continue;
          }

          let parsed: ParsedLocation;
          try {
            parsed = parseLocationMetadata(html!, finalUrl!);
          } catch {
            try {
              parsed = parseLocationMetadata(html!, locationUrl);
            } catch {
              skipped++;
              continue;
            }
          }

          if (!parsed.countryName) parsed.countryName = country.name;
          if (!parsed.districtName) parsed.districtName = state.name;
          if (!parsed.cityName) parsed.cityName = locationItem.name;
          if (parsed.displayName.toLowerCase().startsWith('location-')) {
            parsed.displayName = locationItem.name;
          }

          await this.ensureCoordinates(parsed, geocoder);

          if (!this.isAllowedCountry(parsed.countryName)) {
            skipped++;
            continue;
          }

          const { created } = await this.upsertLocation(parsed);
          if (created) inserted++;
          else updated++;
          processed++;
        }
      }
    }

    return {
      locale,
      mode,
      countries_total: countriesTotal,
      countries_selected: countriesSelected,
      states_total: statesTotal,
      locations_total: locationsTotal,
      processed,
      inserted,
      updated,
      skipped,
      errors,
      blocked_http: blockedHttp,
      blocked_transport: blockedTransport,
      status_counts: statusCounts,
      sample_errors: sampleErrors,
    };
  }

  async geocodeMissingLocations(params: {
    limit?: number;
    startAfterId?: number;
    locale?: string;
  }): Promise<Record<string, number | null>> {
    return this.geocodeLocations({
      limit: params.limit ?? 500,
      startAfterId: params.startAfterId ?? null,
      locale: params.locale ?? null,
      countryQuery: null,
      forceRegeocode: false,
    });
  }

  async refreshGeocodeLocations(params: {
    countryQuery?: string | null;
    limit?: number;
    startAfterId?: number;
    locale?: string;
  }): Promise<Record<string, number | null>> {
    return this.geocodeLocations({
      limit: params.limit ?? 500,
      startAfterId: params.startAfterId ?? null,
      locale: params.locale ?? null,
      countryQuery: params.countryQuery ?? null,
      forceRegeocode: true,
    });
  }

  async refreshGeocodeLocationsAll(params: {
    countryQuery?: string | null;
    locale?: string;
    startAfterId?: number;
    chunkSize?: number;
  }): Promise<Record<string, number | null>> {
    const chunkSize = params.chunkSize ?? 500;
    if (chunkSize <= 0) throw new Error('chunkSize must be greater than 0');

    let totalScanned = 0;
    let totalUpdated = 0;
    let totalUnresolved = 0;
    let totalErrors = 0;
    let cursor = params.startAfterId ?? null;

    while (true) {
      const batch = await this.geocodeLocations({
        limit: chunkSize,
        startAfterId: cursor,
        locale: params.locale ?? null,
        countryQuery: params.countryQuery ?? null,
        forceRegeocode: true,
      });

      const scanned = Number(batch.scanned ?? 0);
      totalScanned += scanned;
      totalUpdated += Number(batch.updated ?? 0);
      totalUnresolved += Number(batch.unresolved ?? 0);
      totalErrors += Number(batch.errors ?? 0);

      if (scanned === 0) break;
      const nextCursor = batch.next_start_after_id;
      if (nextCursor == null) break;
      if (cursor != null && nextCursor <= cursor) break;
      cursor = nextCursor;
    }

    return {
      scanned: totalScanned,
      updated: totalUpdated,
      unresolved: totalUnresolved,
      errors: totalErrors,
      next_start_after_id: cursor,
    };
  }

  async refreshGeocodeSingleLocation(params: {
    locationId?: number;
    diyanetLocationId?: number;
    maxQueries?: number;
    perQueryTimeoutSeconds?: number;
    disableThrottle?: boolean;
  }): Promise<Record<string, unknown>> {
    if ((params.locationId == null) === (params.diyanetLocationId == null)) {
      throw new Error(
        'Provide exactly one of: locationId or diyanetLocationId',
      );
    }

    if (!this.config.geocoderEnabled) {
      throw new Error('Geocoder is disabled. Set GEOCODER_ENABLED=true.');
    }

    const where: Record<string, unknown> = {};
    if (params.locationId != null) where['id'] = params.locationId;
    else where['diyanetLocationId'] = params.diyanetLocationId;

    const location = await this.locationRepo.findOne({ where });
    if (!location) throw new Error('Location not found');

    const geocoder = new GeocoderService(this.config);
    const parsed: ParsedLocation = {
      diyanetLocationId: location.diyanetLocationId,
      locale: location.locale,
      slug: location.slug,
      displayName: location.displayName,
      countryName: location.countryName,
      cityName: location.cityName,
      districtName: location.districtName,
      latitude: null,
      longitude: null,
      sourceUrl: location.sourceUrl,
    };

    let geocodeResult: GeocodeResult | null;
    try {
      geocodeResult = await geocoder.geocodeLocation(parsed, {
        maxQueries: params.maxQueries ?? 4,
        perQueryTimeout: params.perQueryTimeoutSeconds ?? 4.0,
        throttle: !(params.disableThrottle ?? true),
      });
    } catch {
      return {
        location_id: Number(location.id),
        diyanet_location_id: location.diyanetLocationId,
        updated: false,
        unresolved: true,
        latitude: location.latitude,
        longitude: location.longitude,
      };
    }

    if (!geocodeResult) {
      return {
        location_id: Number(location.id),
        diyanet_location_id: location.diyanetLocationId,
        updated: false,
        unresolved: true,
        latitude: location.latitude,
        longitude: location.longitude,
      };
    }

    const { lat, lng } = geocodeResult;
    location.latitude = lat;
    location.longitude = lng;
    location.geocodeConfidence = geocodeResult.confidence;
    location.geocodeQuery = geocodeResult.query;
    await this.locationRepo.save(location);
    await this.dataSource.query(
      `UPDATE locations SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
      [lng, lat, location.id],
    );

    return {
      location_id: Number(location.id),
      diyanet_location_id: location.diyanetLocationId,
      updated: true,
      unresolved: false,
      latitude: lat,
      longitude: lng,
      confidence: geocodeResult.confidence,
      geocode_query: geocodeResult.query,
    };
  }

  private async geocodeLocations(params: {
    limit: number;
    startAfterId: number | null;
    locale: string | null;
    countryQuery: string | null;
    forceRegeocode: boolean;
  }): Promise<Record<string, number | null>> {
    if (!this.config.geocoderEnabled) {
      throw new Error('Geocoder is disabled. Set GEOCODER_ENABLED=true.');
    }

    const countryFilter = (params.countryQuery ?? '').trim();
    let scanned = 0;
    let updated = 0;
    let unresolved = 0;
    let errors = 0;
    let nextStartAfterId: number | null = null;

    const qb = this.locationRepo
      .createQueryBuilder('l')
      .where('l.is_active = true')
      .orderBy('l.id', 'ASC')
      .limit(params.limit);

    if (!params.forceRegeocode) {
      qb.andWhere(
        '(l.latitude IS NULL OR l.longitude IS NULL OR l.geom IS NULL)',
      );
    }

    const localeFilter = (params.locale ?? '').trim();
    if (localeFilter) qb.andWhere('l.locale = :locale', { locale: localeFilter });

    if (countryFilter) {
      qb.andWhere('l.country_name IS NOT NULL');
      qb.andWhere('l.country_name ILIKE :countryFilter', {
        countryFilter: `%${countryFilter}%`,
      });
    }

    if (params.startAfterId != null) {
      qb.andWhere('l.id > :startAfterId', {
        startAfterId: params.startAfterId,
      });
    }

    const targets = await qb.getMany();
    const geocoder = new GeocoderService(this.config);

    for (const location of targets) {
      scanned++;
      nextStartAfterId = Number(location.id);

      const hasLatLng =
        location.latitude != null && location.longitude != null;
      if (hasLatLng && !params.forceRegeocode) {
        await this.dataSource.query(
          `UPDATE locations SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
          [location.longitude, location.latitude, location.id],
        );
        updated++;
        continue;
      }

      const parsed: ParsedLocation = {
        diyanetLocationId: location.diyanetLocationId,
        locale: location.locale,
        slug: location.slug,
        displayName: location.displayName,
        countryName: location.countryName,
        cityName: location.cityName,
        districtName: location.districtName,
        latitude: null,
        longitude: null,
        sourceUrl: location.sourceUrl,
      };

      let geocodeResult: GeocodeResult | null;
      try {
        geocodeResult = await geocoder.geocodeLocation(parsed);
      } catch {
        errors++;
        continue;
      }

      if (!geocodeResult) {
        if (params.forceRegeocode) {
          location.latitude = null;
          location.longitude = null;
          location.geom = null;
          await this.locationRepo.save(location);
        }
        unresolved++;
        continue;
      }

      const { lat, lng } = geocodeResult;
      location.latitude = lat;
      location.longitude = lng;
      location.geocodeConfidence = geocodeResult.confidence;
      location.geocodeQuery = geocodeResult.query;
      await this.locationRepo.save(location);
      await this.dataSource.query(
        `UPDATE locations SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
        [lng, lat, location.id],
      );
      updated++;
    }

    return {
      scanned,
      updated,
      unresolved,
      errors,
      next_start_after_id: nextStartAfterId,
    };
  }

  async warmupLocationYear(
    location: Location,
    requestedYear: number,
  ): Promise<Record<string, number>> {
    this.logger.log(
      `Warming up location ${location.id} (${location.displayName}) for year ${requestedYear}`,
    );

    const rows = await this.diyanetApi.fetchYearlyPrayerTimes(
      location.diyanetLocationId,
    );

    const filteredRows = rows.filter((r) =>
      r.prayerDate.startsWith(`${requestedYear}-`),
    );

    if (!filteredRows.length) {
      throw new YearUnavailableError(
        `No prayer times for year ${requestedYear} returned by API for location ${location.diyanetLocationId}`,
      );
    }

    const upserted = await this.upsertPrayerTimes(
      Number(location.id),
      location.sourceUrl,
      filteredRows,
    );

    return {
      location_id: Number(location.id),
      diyanet_location_id: location.diyanetLocationId,
      requested_year: requestedYear,
      upserted_days: upserted,
    };
  }

  async warmupLocationYearById(
    locationId: number,
    requestedYear: number,
  ): Promise<Record<string, number>> {
    const location = await this.locationRepo.findOne({
      where: { id: locationId },
    });
    if (!location) throw new Error(`Location not found: ${locationId}`);
    return this.warmupLocationYear(location, requestedYear);
  }

  async warmupHotLocations(requestedYear: number): Promise<number> {
    const hotLocations = await this.locationRepo.find({
      where: { isHot: true, isActive: true },
      take: this.config.hotLocationsLimit,
    });

    let warmed = 0;
    for (const location of hotLocations) {
      try {
        await this.warmupLocationYear(location, requestedYear);
        warmed++;
      } catch {
        // skip
      }
    }
    return warmed;
  }
}
