import {
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Query,
} from '@nestjs/common';
import {
    LocationOutDto,
    LocationSearchItemDto,
    LocationSearchResponseDto,
} from '../dto/prayer-times.dto';
import { LocationService } from '../services/location.service';

@Controller('v1/locations')
export class LocationsController {
  constructor(private readonly locationService: LocationService) {}

  @Get('nearest')
  async nearest(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
  ): Promise<LocationOutDto> {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      throw new HttpException('lat must be between -90 and 90', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      throw new HttpException('lng must be between -180 and 180', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const nearest = await this.locationService.getNearest(latNum, lngNum);
    if (!nearest) {
      throw new HttpException('No locations loaded yet', HttpStatus.NOT_FOUND);
    }

    const { location, distanceM } = nearest;
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

  @Get('search')
  async search(
    @Query('q') q: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('limit') limitStr?: string,
  ): Promise<LocationSearchResponseDto> {
    if (!q || q.length < 2 || q.length > 120) {
      throw new HttpException(
        'q must be between 2 and 120 characters',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const limit = Math.min(Math.max(parseInt(limitStr ?? '20', 10) || 20, 1), 100);
    const latNum = lat != null ? parseFloat(lat) : undefined;
    const lngNum = lng != null ? parseFloat(lng) : undefined;

    if ((latNum == null) !== (lngNum == null)) {
      throw new HttpException(
        'lat and lng must be provided together',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    let found = await this.locationService.search(q, limit, latNum, lngNum);

    let results: LocationSearchItemDto[] = found.map((r) => ({
      id: Number(r.location.id),
      diyanet_location_id: r.location.diyanetLocationId,
      display_name: r.location.displayName,
      country_name: r.location.countryName,
      city_name: r.location.cityName,
      district_name: r.location.districtName,
      latitude: r.location.latitude,
      longitude: r.location.longitude,
      distance_m:
        r.distanceM != null ? Math.round(r.distanceM * 100) / 100 : null,
      match_type: r.matchType,
    }));

    if (!results.length && latNum != null && lngNum != null) {
      const nearest = await this.locationService.getNearest(latNum, lngNum);
      if (nearest) {
        results = [
          {
            id: Number(nearest.location.id),
            diyanet_location_id: nearest.location.diyanetLocationId,
            display_name: nearest.location.displayName,
            country_name: nearest.location.countryName,
            city_name: nearest.location.cityName,
            district_name: nearest.location.districtName,
            latitude: nearest.location.latitude,
            longitude: nearest.location.longitude,
            distance_m: Math.round(nearest.distanceM * 100) / 100,
            match_type: 'nearby',
          },
        ];
      }
    }

    return { query: q, total: results.length, results };
  }
}
