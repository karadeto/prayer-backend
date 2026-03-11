import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Response } from 'express';

interface PlacePhoto {
  photo_reference: string;
  height: number;
  width: number;
}

interface PlaceResult {
  place_id: string;
  name: string;
  vicinity?: string;
  formatted_address?: string;
  geometry: { location: { lat: number; lng: number } };
  rating?: number;
  user_ratings_total?: number;
  photos?: PlacePhoto[];
}

interface MosqueDto {
  place_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  rating: number | null;
  ratings_total: number | null;
  photo_url: string | null;
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

  private toDto(place: PlaceResult): MosqueDto {
    const photoRef = place.photos?.[0]?.photo_reference;
    return {
      place_id: place.place_id,
      name: place.name,
      address: place.vicinity ?? place.formatted_address ?? '',
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      rating: place.rating ?? null,
      ratings_total: place.user_ratings_total ?? null,
      photo_url: photoRef
        ? `/v1/mosques/photo?ref=${encodeURIComponent(photoRef)}`
        : null,
    };
  }

  @Get('photo')
  async photo(
    @Query('ref') ref: string,
    @Query('maxwidth') maxwidthStr?: string,
    @Res() res?: Response,
  ): Promise<void> {
    if (!ref) {
      throw new HttpException('ref is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.apiKey) {
      throw new HttpException(
        'Google Places API key not configured',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const maxwidth = parseInt(maxwidthStr ?? '400', 10) || 400;

    try {
      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/place/photo',
        {
          params: {
            photoreference: ref,
            maxwidth,
            key: this.apiKey,
          },
          responseType: 'stream',
          timeout: 10000,
        },
      );

      res!.set({
        'Content-Type': response.headers['content-type'] ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });
      response.data.pipe(res!);
    } catch (err) {
      this.logger.error('Failed to proxy photo', err);
      throw new HttpException('Failed to fetch photo', HttpStatus.BAD_GATEWAY);
    }
  }

  @Get('nearby')
  async nearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radiusStr?: string,
  ): Promise<{ results: MosqueDto[] }> {
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

      const results = (data.results as PlaceResult[]).map((p) => this.toDto(p));
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
  ): Promise<{ results: MosqueDto[] }> {
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

      const results = (data.results as PlaceResult[]).map((p) => this.toDto(p));
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
