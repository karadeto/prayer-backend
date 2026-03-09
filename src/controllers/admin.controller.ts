import {
    Controller,
    HttpException,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CrawlerSourceError } from '../crawler/diyanet-client';
import { Location } from '../entities/location.entity';
import { IngestionService, YearUnavailableError } from '../services/ingestion.service';

@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly ingestionService: IngestionService,
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    private readonly dataSource: DataSource,
  ) {}

  @Patch('location/:locationId/coordinates')
  async setCoordinates(
    @Param('locationId') locationIdStr: string,
    @Query('lat') latStr: string,
    @Query('lng') lngStr: string,
  ) {
    const locationId = parseInt(locationIdStr, 10);
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (isNaN(lat) || lat < -90 || lat > 90) {
      throw new HttpException('lat must be between -90 and 90', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      throw new HttpException('lng must be between -180 and 180', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const location = await this.locationRepo.findOne({ where: { id: locationId } });
    if (!location) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND);
    }

    location.latitude = lat;
    location.longitude = lng;
    location.geocodeConfidence = 1.0;
    location.geocodeVerified = true;
    await this.locationRepo.save(location);

    await this.dataSource.query(
      `UPDATE locations SET geom = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3`,
      [lng, lat, location.id],
    );

    return {
      location_id: Number(location.id),
      diyanet_location_id: location.diyanetLocationId,
      display_name: location.displayName,
      latitude: lat,
      longitude: lng,
      geocode_verified: true,
    };
  }

  @Post('crawl/locations')
  async crawlLocations(@Query('limit') limitStr?: string) {
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    try {
      return await this.ingestionService.crawlLocationsFromSitemap(limit);
    } catch (err) {
      if (err instanceof CrawlerSourceError) {
        throw new HttpException(err.message, HttpStatus.BAD_GATEWAY);
      }
      throw err;
    }
  }

  @Post('crawl/location-by-url')
  async crawlLocationByUrl(
    @Query('url') url: string,
    @Query('lat') latStr?: string,
    @Query('lng') lngStr?: string,
  ) {
    if (!url || url.length < 20) {
      throw new HttpException('url must be at least 20 characters', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const lat = latStr != null ? parseFloat(latStr) : undefined;
    const lng = lngStr != null ? parseFloat(lngStr) : undefined;
    try {
      return await this.ingestionService.crawlSingleLocationByUrl(
        url,
        lat,
        lng,
      );
    } catch (err) {
      if (err instanceof CrawlerSourceError) {
        throw new HttpException(err.message, HttpStatus.BAD_GATEWAY);
      }
      if (err instanceof Error && err.message.includes('not allowed')) {
        throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw err;
    }
  }

  @Post('seed/eu-tr/id-range')
  async seedIdRange(
    @Query('start_id') startIdStr: string,
    @Query('end_id') endIdStr: string,
    @Query('locale') locale?: string,
    @Query('max_success') maxSuccessStr?: string,
    @Query('probe_timeout_seconds') probeTimeoutStr?: string,
    @Query('max_blocked_streak') maxBlockedStr?: string,
    @Query('geocode_missing') geocodeMissingStr?: string,
  ) {
    const startId = parseInt(startIdStr, 10);
    const endId = parseInt(endIdStr, 10);
    if (isNaN(startId) || startId < 1 || isNaN(endId) || endId < 1) {
      throw new HttpException('start_id and end_id must be >= 1', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return this.ingestionService.seedLocationsByIdRange({
      startId,
      endId,
      locale: locale ?? 'tr-TR',
      maxSuccess: maxSuccessStr ? parseInt(maxSuccessStr, 10) : undefined,
      probeTimeoutSeconds: probeTimeoutStr
        ? parseFloat(probeTimeoutStr)
        : undefined,
      maxBlockedStreak: maxBlockedStr
        ? parseInt(maxBlockedStr, 10)
        : undefined,
      geocodeMissing: geocodeMissingStr === 'true',
    });
  }

  @Post('seed/eu-tr/hierarchy')
  async seedHierarchy(
    @Query('locale') locale?: string,
    @Query('geocode_missing') geocodeMissingStr?: string,
    @Query('skip_location_pages') skipLocationPagesStr?: string,
    @Query('country_id') countryIdStr?: string,
    @Query('max_countries') maxCountriesStr?: string,
    @Query('max_states_per_country') maxStatesStr?: string,
    @Query('max_locations_per_state') maxLocationsStr?: string,
    @Query('probe_timeout_seconds') probeTimeoutStr?: string,
    @Query('request_delay_seconds') requestDelayStr?: string,
    @Query('location_fetch_concurrency') fetchConcurrencyStr?: string,
    @Query('location_fetch_retries') fetchRetriesStr?: string,
  ) {
    return this.ingestionService.seedLocationsFromHierarchy({
      locale: locale ?? 'tr-TR',
      geocodeMissing: geocodeMissingStr === 'true' || geocodeMissingStr === undefined,
      skipLocationPages: skipLocationPagesStr === 'true' || skipLocationPagesStr === undefined,
      countryId: countryIdStr ? parseInt(countryIdStr, 10) : undefined,
      maxCountries: maxCountriesStr ? parseInt(maxCountriesStr, 10) : undefined,
      maxStatesPerCountry: maxStatesStr
        ? parseInt(maxStatesStr, 10)
        : undefined,
      maxLocationsPerState: maxLocationsStr
        ? parseInt(maxLocationsStr, 10)
        : undefined,
      probeTimeoutSeconds: probeTimeoutStr
        ? parseFloat(probeTimeoutStr)
        : undefined,
      requestDelaySeconds: requestDelayStr
        ? parseFloat(requestDelayStr)
        : 0.0,
      locationFetchConcurrency: fetchConcurrencyStr
        ? parseInt(fetchConcurrencyStr, 10)
        : undefined,
      locationFetchRetries: fetchRetriesStr
        ? parseInt(fetchRetriesStr, 10)
        : undefined,
    });
  }

  @Post('geocode/missing')
  async geocodeMissing(
    @Query('limit') limitStr?: string,
    @Query('start_after_id') startAfterIdStr?: string,
    @Query('locale') locale?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : 500;
    try {
      return await this.ingestionService.geocodeMissingLocations({
        limit,
        startAfterId: startAfterIdStr
          ? parseInt(startAfterIdStr, 10)
          : undefined,
        locale,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('disabled')) {
        throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw err;
    }
  }

  @Post('geocode/refresh')
  async geocodeRefresh(
    @Query('country_query') countryQuery?: string,
    @Query('limit') limitStr?: string,
    @Query('start_after_id') startAfterIdStr?: string,
    @Query('locale') locale?: string,
    @Query('run_all') runAllStr?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : 500;
    try {
      if (runAllStr === 'true') {
        return await this.ingestionService.refreshGeocodeLocationsAll({
          countryQuery,
          locale,
          startAfterId: startAfterIdStr
            ? parseInt(startAfterIdStr, 10)
            : undefined,
          chunkSize: limit,
        });
      }
      return await this.ingestionService.refreshGeocodeLocations({
        countryQuery,
        limit,
        startAfterId: startAfterIdStr
          ? parseInt(startAfterIdStr, 10)
          : undefined,
        locale,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('disabled')) {
        throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw err;
    }
  }

  @Post('geocode/refresh/single')
  async geocodeRefreshSingle(
    @Query('location_id') locationIdStr?: string,
    @Query('diyanet_location_id') diyanetLocationIdStr?: string,
    @Query('max_queries') maxQueriesStr?: string,
    @Query('per_query_timeout_seconds') perQueryTimeoutStr?: string,
    @Query('disable_throttle') disableThrottleStr?: string,
  ) {
    try {
      return await this.ingestionService.refreshGeocodeSingleLocation({
        locationId: locationIdStr
          ? parseInt(locationIdStr, 10)
          : undefined,
        diyanetLocationId: diyanetLocationIdStr
          ? parseInt(diyanetLocationIdStr, 10)
          : undefined,
        maxQueries: maxQueriesStr ? parseInt(maxQueriesStr, 10) : 4,
        perQueryTimeoutSeconds: perQueryTimeoutStr
          ? parseFloat(perQueryTimeoutStr)
          : 4.0,
        disableThrottle: disableThrottleStr !== 'false',
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          throw new HttpException(err.message, HttpStatus.NOT_FOUND);
        }
        if (
          err.message.includes('Provide exactly one') ||
          err.message.includes('disabled')
        ) {
          throw new HttpException(err.message, HttpStatus.UNPROCESSABLE_ENTITY);
        }
      }
      throw err;
    }
  }

  @Post('warmup/location/:locationId')
  async warmupByLocationId(
    @Param('locationId') locationIdStr: string,
    @Query('year') yearStr?: string,
  ) {
    const locationId = parseInt(locationIdStr, 10);
    const year = yearStr
      ? parseInt(yearStr, 10)
      : new Date().getFullYear();

    const location = await this.locationRepo.findOne({
      where: { id: locationId },
    });
    if (!location) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND);
    }

    try {
      return await this.ingestionService.warmupLocationYear(location, year);
    } catch (err) {
      if (err instanceof YearUnavailableError) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw err;
    }
  }

  @Post('warmup/diyanet/:diyanetLocationId')
  async warmupByDiyanetId(
    @Param('diyanetLocationId') diyanetIdStr: string,
    @Query('year') yearStr?: string,
  ) {
    const diyanetId = parseInt(diyanetIdStr, 10);
    const year = yearStr
      ? parseInt(yearStr, 10)
      : new Date().getFullYear();

    const location = await this.locationRepo.findOne({
      where: { diyanetLocationId: diyanetId },
    });
    if (!location) {
      throw new HttpException('Location not found', HttpStatus.NOT_FOUND);
    }

    try {
      return await this.ingestionService.warmupLocationYear(location, year);
    } catch (err) {
      if (err instanceof YearUnavailableError) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw err;
    }
  }
}
