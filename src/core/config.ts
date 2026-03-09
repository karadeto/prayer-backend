export interface AppConfig {
  appName: string;
  appVersion: string;
  environment: string;
  debug: boolean;

  databaseUrl: string;

  crawlerBaseUrl: string;
  crawlerSitemapIndexPathsCsv: string;
  crawlerTimeoutSeconds: number;
  crawlerUserAgent: string;
  crawlerConcurrency: number;

  geocoderEnabled: boolean;
  googleGeocodingApiKey: string;
  geocoderTimeoutSeconds: number;
  geocoderMinConfidence: number;
  geocodeDebugLogs: boolean;
  geocodeProgressEvery: number;
  seedProbeTimeoutSeconds: number;
  seedMaxBlockedStreak: number;
  seedLocationFetchConcurrency: number;
  seedLocationFetchRetries: number;

  schedulerEnabled: boolean;
  autoWarmupOnMiss: boolean;

  allowedCountryKeywordsCsv: string;

  hotLocationsLimit: number;
}

export function loadConfig(): AppConfig {
  return {
    appName: process.env.APP_NAME ?? 'Prayer API',
    appVersion: process.env.APP_VERSION ?? '0.1.0',
    environment: process.env.ENVIRONMENT ?? 'dev',
    debug: process.env.DEBUG === 'true',

    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/prayer_api',

    crawlerBaseUrl:
      process.env.CRAWLER_BASE_URL ??
      'https://namazvakitleri.diyanet.gov.tr',
    crawlerSitemapIndexPathsCsv:
      process.env.CRAWLER_SITEMAP_INDEX_PATHS_CSV ??
      '/sitemap.xml,/sitemap-index.xml,/sitemap_index.xml,/sitemaps/sitemap.xml',
    crawlerTimeoutSeconds: +(process.env.CRAWLER_TIMEOUT_SECONDS ?? 30),
    crawlerUserAgent:
      process.env.CRAWLER_USER_AGENT ?? 'prayer-api/0.1 (+https://github.com)',
    crawlerConcurrency: +(process.env.CRAWLER_CONCURRENCY ?? 5),

    geocoderEnabled: (process.env.GEOCODER_ENABLED ?? 'true') === 'true',
    googleGeocodingApiKey: process.env.GOOGLE_GEOCODING_API_KEY ?? '',
    geocoderTimeoutSeconds: +(process.env.GEOCODER_TIMEOUT_SECONDS ?? 20),
    geocoderMinConfidence: +(process.env.GEOCODER_MIN_CONFIDENCE ?? 0.5),
    geocodeDebugLogs: process.env.GEOCODE_DEBUG_LOGS === 'true',
    geocodeProgressEvery: +(process.env.GEOCODE_PROGRESS_EVERY ?? 50),
    seedProbeTimeoutSeconds: +(process.env.SEED_PROBE_TIMEOUT_SECONDS ?? 6),
    seedMaxBlockedStreak: +(process.env.SEED_MAX_BLOCKED_STREAK ?? 5),
    seedLocationFetchConcurrency: +(
      process.env.SEED_LOCATION_FETCH_CONCURRENCY ?? 10
    ),
    seedLocationFetchRetries: +(process.env.SEED_LOCATION_FETCH_RETRIES ?? 2),

    schedulerEnabled: (process.env.SCHEDULER_ENABLED ?? 'true') === 'true',
    autoWarmupOnMiss: (process.env.AUTO_WARMUP_ON_MISS ?? 'true') === 'true',

    allowedCountryKeywordsCsv:
      process.env.ALLOWED_COUNTRY_KEYWORDS_CSV ??
      'turkiye,turkey,almanya,germany,fransa,france,belcika,belgium,hollanda,netherlands,avusturya,austria,isvicre,switzerland,isvec,sweden,norvec,norway,denmark,italya,italy,ispanya,spain,portekiz,portugal,yunanistan,greece,polonya,poland,romanya,romania,bulgaristan,hungary,macaristan,hirvatistan,croatia,sirbistan,serbia,bosna,bosnia,arnavutluk,albania,makedonya,kosova,kosovo,slovenya,slovenia,slovakya,slovakia,cekya,czech,republic,irlanda,ireland,birlesik krallik,united kingdom,uk,ingiltere,england,finlandiya,finland,estonya,estonia,letonya,latvia,litvanya,lithuania,luksemburg,luxembourg,malta,kipris,cyprus',

    hotLocationsLimit: +(process.env.HOT_LOCATIONS_LIMIT ?? 200),
  };
}

export function getAllowedCountryKeywords(csv: string): string[] {
  return csv
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function getCrawlerSitemapIndexPaths(csv: string): string[] {
  const paths = csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!paths.length) return ['/sitemap.xml'];
  return paths.map((p) => (p.startsWith('/') ? p : `/${p}`));
}

