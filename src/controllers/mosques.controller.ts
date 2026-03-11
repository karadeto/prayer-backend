import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface PlaceResult {
  place_id: string;
  name: string;
  vicinity?: string;
  formatted_address?: string;
  geometry: { location: { lat: number; lng: number } };
}

interface NearbyMosqueDto {
  place_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

@Controller('v1/mosques')
export class MosquesController {
  private readonly logger = new Logger(MosquesController.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey =
      config.get<string>('GOOGLE_PLACES_API_KEY') ??
      config.get<string>('GOOGLE_GEOCODING_API_KEY') ??
      '';
  }

  @Get('nearby')
  async nearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radiusStr?: string,
  ): Promise<{ results: NearbyMosqueDto[] }> {
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

    if (!this.apiKey) {
      throw new HttpException(
        'Google Places API key not configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const radius = Math.min(
      Math.max(parseInt(radiusStr ?? '5000', 10) || 5000, 500),
      50000,
    );

    try {
      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
        {
          params: {
            location: `${latNum},${lngNum}`,
            radius,
            type: 'mosque',
            key: this.apiKey,
          },
          timeout: 10000,
        },
      );

      const data = response.data;

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        this.logger.warn(`Places API status: ${data.status} - ${data.error_message ?? ''}`);
        throw new HttpException(
          `Places API error: ${data.status}`,
          HttpStatus.BAD_GATEWAY,
        );
      }

      const results: NearbyMosqueDto[] = (data.results as PlaceResult[]).map(
        (place) => ({
          place_id: place.place_id,
          name: place.name,
          address: place.vicinity ?? place.formatted_address ?? '',
          latitude: place.geometry.location.lat,
          longitude: place.geometry.location.lng,
        }),
      );

      return { results };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error('Failed to fetch nearby mosques', err);
      throw new HttpException(
        'Failed to fetch nearby mosques',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Get('search')
  async search(
    @Query('q') q: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ): Promise<{ results: NearbyMosqueDto[] }> {
    if (!q || q.length < 2) {
      throw new HttpException(
        'q must be at least 2 characters',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (!this.apiKey) {
      throw new HttpException(
        'Google Places API key not configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const params: Record<string, string> = {
      query: `${q} mosque`,
      type: 'mosque',
      key: this.apiKey,
    };

    const latNum = lat != null ? parseFloat(lat) : undefined;
    const lngNum = lng != null ? parseFloat(lng) : undefined;
    if (latNum != null && lngNum != null) {
      params.location = `${latNum},${lngNum}`;
      params.radius = '50000';
    }

    try {
      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        { params, timeout: 10000 },
      );

      const data = response.data;

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        throw new HttpException(
          `Places API error: ${data.status}`,
          HttpStatus.BAD_GATEWAY,
        );
      }

      const results: NearbyMosqueDto[] = (data.results as PlaceResult[]).map(
        (place) => ({
          place_id: place.place_id,
          name: place.name,
          address: place.vicinity ?? place.formatted_address ?? '',
          latitude: place.geometry.location.lat,
          longitude: place.geometry.location.lng,
        }),
      );

      return { results };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error('Failed to search mosques', err);
      throw new HttpException(
        'Failed to search mosques',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
