import { Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../core/config';
import { normalizeDiyanetName } from '../core/name-normalizer';
import { normalizeLookup } from '../core/text-utils';
import { ParsedLocation } from '../crawler/parsers';

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const COUNTRY_ALIASES: Record<string, string> = {
  almanya: 'Germany',
  turkiye: 'Turkey',
  turkey: 'Turkey',
  fransa: 'France',
  italya: 'Italy',
  ispanya: 'Spain',
  hollanda: 'Netherlands',
  belcika: 'Belgium',
  avusturya: 'Austria',
  isvicre: 'Switzerland',
  ingiltere: 'United Kingdom',
  'birlesik krallik': 'United Kingdom',
  isvec: 'Sweden',
  norvec: 'Norway',
  danimarka: 'Denmark',
  yunanistan: 'Greece',
  polonya: 'Poland',
  romanya: 'Romania',
  bulgaristan: 'Bulgaria',
  cekya: 'Czechia',
  slovakya: 'Slovakia',
  slovenya: 'Slovenia',
  hirvatistan: 'Croatia',
  sirbistan: 'Serbia',
  arnavutluk: 'Albania',
  makedonya: 'North Macedonia',
  kosova: 'Kosovo',
  bosna: 'Bosnia and Herzegovina',
  finlandiya: 'Finland',
  portekiz: 'Portugal',
  irlanda: 'Ireland',
  luksemburg: 'Luxembourg',
  malta: 'Malta',
  kipris: 'Cyprus',
};

function resolveCountryEnglish(country: string | null): string | null {
  if (!country) return null;
  const key = normalizeLookup(country);
  return COUNTRY_ALIASES[key] ?? country;
}

// ── Google response types ───────────────────────────────────────────

interface GoogleGeocodeResult {
  geometry: {
    location: { lat: number; lng: number };
    location_type?: string;
  };
  formatted_address: string;
  types?: string[];
  partial_match?: boolean;
  address_components: {
    long_name: string;
    short_name: string;
    types: string[];
  }[];
}

interface GoogleGeocodeResponse {
  status: string;
  results: GoogleGeocodeResult[];
  error_message?: string;
}

// ── Public result type ──────────────────────────────────────────────

export interface GeocodeResult {
  lat: number;
  lng: number;
  confidence: number;
  query: string;
  formattedAddress: string;
}

// ── Confidence scoring ──────────────────────────────────────────────

const LOCATION_TYPE_SCORES: Record<string, number> = {
  ROOFTOP: 1.0,
  RANGE_INTERPOLATED: 0.8,
  GEOMETRIC_CENTER: 0.6,
  APPROXIMATE: 0.3,
};

const GOOD_RESULT_TYPES = new Set([
  'locality',
  'sublocality',
  'neighborhood',
  'postal_code',
  'administrative_area_level_3',
  'administrative_area_level_4',
]);

const MEDIUM_RESULT_TYPES = new Set([
  'administrative_area_level_2',
  'administrative_area_level_1',
]);

const BAD_RESULT_TYPES = new Set(['country', 'continent']);

function computeConfidence(
  result: GoogleGeocodeResult,
  expectedCountry: string | null,
): number {
  const locationType = result.geometry.location_type ?? 'APPROXIMATE';
  let score = LOCATION_TYPE_SCORES[locationType] ?? 0.3;

  const types = new Set(result.types ?? []);
  if ([...types].some((t) => GOOD_RESULT_TYPES.has(t))) {
    score += 0.2;
  } else if ([...types].some((t) => MEDIUM_RESULT_TYPES.has(t))) {
    score += 0.05;
  }
  if ([...types].some((t) => BAD_RESULT_TYPES.has(t))) {
    score -= 0.3;
  }

  if (result.partial_match) {
    score -= 0.2;
  }

  if (expectedCountry) {
    const resultCountry = result.address_components?.find((c) =>
      c.types.includes('country'),
    );
    if (resultCountry) {
      const expected = normalizeLookup(expectedCountry);
      const actual = normalizeLookup(resultCountry.long_name);
      const actualShort = normalizeLookup(resultCountry.short_name);
      const expectedResolved = normalizeLookup(
        COUNTRY_ALIASES[expected] ?? expectedCountry,
      );

      const match =
        actual === expected ||
        actual === expectedResolved ||
        actualShort === expected ||
        actualShort === expectedResolved;

      if (!match) {
        score -= 0.25;
      } else {
        score += 0.1;
      }
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ── Query builder ───────────────────────────────────────────────────

export function buildLocationQueries(location: ParsedLocation): string[] {
  const country = resolveCountryEnglish(location.countryName);

  const cityNorm = normalizeDiyanetName(location.cityName ?? '');
  const districtNorm = normalizeDiyanetName(location.districtName ?? '');
  const displayNorm = normalizeDiyanetName(location.displayName ?? '');

  const queries: string[] = [];
  const seen = new Set<string>();

  const addQuery = (parts: string[]) => {
    const filtered = parts.filter(Boolean);
    if (!filtered.length) return;
    const query = filtered.join(', ');
    const key = normalizeLookup(query);
    if (!seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
  };

  for (const cityVariant of cityNorm.variants) {
    const distVariants = districtNorm.variants.length ? districtNorm.variants : [''];
    for (const districtVariant of distVariants) {
      if (districtVariant) {
        addQuery([districtVariant, cityVariant, country ?? '']);
      }
      addQuery([cityVariant, country ?? '']);
    }
  }

  for (const displayVariant of displayNorm.variants) {
    addQuery([displayVariant, country ?? '']);
  }

  for (const districtVariant of districtNorm.variants) {
    addQuery([districtVariant, country ?? '']);
  }

  return queries;
}

// ── Service ─────────────────────────────────────────────────────────

export class GeocoderService {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(GeocoderService.name);
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = axios.create({
      timeout: config.geocoderTimeoutSeconds * 1000,
    });
  }

  async geocodeQuery(
    query: string,
    expectedCountry: string | null,
    options?: { timeout?: number },
  ): Promise<GeocodeResult | null> {
    if (!query.trim()) return null;

    const apiKey = this.config.googleGeocodingApiKey;
    if (!apiKey) {
      this.logger.warn('GOOGLE_GEOCODING_API_KEY is not set, skipping geocode');
      return null;
    }

    const startedAt = Date.now();

    try {
      const response = await this.client.get<GoogleGeocodeResponse>(
        GOOGLE_GEOCODE_URL,
        {
          params: { address: query, key: apiKey },
          timeout: options?.timeout ? options.timeout * 1000 : undefined,
        },
      );

      const data = response.data;

      if (data.status === 'ZERO_RESULTS' || !data.results?.length) {
        if (this.config.geocodeDebugLogs) {
          const elapsed = Date.now() - startedAt;
          this.logger.log(
            `geocode_query empty | query=${query} | status=${data.status} | elapsed_ms=${elapsed}`,
          );
        }
        return null;
      }

      if (data.status !== 'OK') {
        this.logger.warn(
          `Google Geocoding API error: ${data.status} - ${data.error_message ?? ''}`,
        );
        return null;
      }

      // Score all candidates, pick best
      let best: GeocodeResult | null = null;

      for (const candidate of data.results) {
        const { lat, lng } = candidate.geometry.location;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

        const confidence = computeConfidence(candidate, expectedCountry);

        if (!best || confidence > best.confidence) {
          best = {
            lat,
            lng,
            confidence,
            query,
            formattedAddress: candidate.formatted_address,
          };
        }
      }

      if (!best) return null;

      // Reject if below threshold
      if (best.confidence < this.config.geocoderMinConfidence) {
        const elapsed = Date.now() - startedAt;
        this.logger.warn(
          `geocode_query LOW_CONFIDENCE | query=${query} | confidence=${best.confidence.toFixed(2)} | min=${this.config.geocoderMinConfidence} | address=${best.formattedAddress} | elapsed_ms=${elapsed} → REJECTED`,
        );
        return null;
      }

      if (this.config.geocodeDebugLogs) {
        const elapsed = Date.now() - startedAt;
        this.logger.log(
          `geocode_query match | query=${query} | confidence=${best.confidence.toFixed(2)} | lat=${best.lat.toFixed(6)} | lng=${best.lng.toFixed(6)} | address=${best.formattedAddress} | elapsed_ms=${elapsed}`,
        );
      }
      return best;
    } catch (err) {
      if (this.config.geocodeDebugLogs) {
        this.logger.error(`geocode_query exception | query=${query}`, err);
      }
      return null;
    }
  }

  async geocodeLocation(
    location: ParsedLocation,
    options?: {
      maxQueries?: number;
      perQueryTimeout?: number;
      throttle?: boolean;
    },
  ): Promise<GeocodeResult | null> {
    const queries = buildLocationQueries(location);
    const expectedCountry = resolveCountryEnglish(location.countryName);

    if (this.config.geocodeDebugLogs) {
      this.logger.log(
        `geocode_location start | diyanet_id=${location.diyanetLocationId} | display_name=${location.displayName} | queries=${queries.length}`,
      );
    }

    let bestOverall: GeocodeResult | null = null;

    for (let idx = 0; idx < queries.length; idx++) {
      if (options?.maxQueries != null && idx >= options.maxQueries) break;
      try {
        const result = await this.geocodeQuery(queries[idx], expectedCountry, {
          timeout: options?.perQueryTimeout,
        });
        if (result) {
          if (!bestOverall || result.confidence > bestOverall.confidence) {
            bestOverall = result;
          }
          if (result.confidence >= 0.8) break;
        }
      } catch (err) {
        if (this.config.geocodeDebugLogs) {
          this.logger.error(
            `geocode_location query_exception | diyanet_id=${location.diyanetLocationId} | query=${queries[idx]}`,
            err,
          );
        }
      }
    }

    if (bestOverall) {
      if (this.config.geocodeDebugLogs) {
        this.logger.log(
          `geocode_location success | diyanet_id=${location.diyanetLocationId} | confidence=${bestOverall.confidence.toFixed(2)} | query=${bestOverall.query} | lat=${bestOverall.lat.toFixed(6)} | lng=${bestOverall.lng.toFixed(6)}`,
        );
      }
      return bestOverall;
    }

    this.logger.warn(
      `geocode_location UNRESOLVED | diyanet_id=${location.diyanetLocationId} | display_name=${location.displayName} | country=${location.countryName} | queries_tried=${queries.length}`,
    );
    return null;
  }
}
