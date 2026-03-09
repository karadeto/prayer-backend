import * as cheerio from 'cheerio';
import { normalizeLookup, normalizeSpaces } from '../core/text-utils';

type CheerioAPI = ReturnType<typeof cheerio.load>;
const load = cheerio.load;

const LOCATION_URL_RE =
  /\/(?<locale>[a-z]{2}-[A-Z]{2})\/(?<id>\d+)(?:\/(?<slug>[^/?#]+))?/;
const DATE_RE =
  /(?<day>\d{1,2})\s+(?<month>[A-Za-zÇĞİÖŞÜçğıöşü]+)/;
const TIME_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
const YEAR_RE = /\b(20\d{2})\b/g;

const MONTHS: Record<string, number> = {
  ocak: 1,
  subat: 2,
  şubat: 2,
  mart: 3,
  nisan: 4,
  mayis: 5,
  mayıs: 5,
  haziran: 6,
  temmuz: 7,
  agustos: 8,
  ağustos: 8,
  eylul: 9,
  eylül: 9,
  ekim: 10,
  kasim: 11,
  kasım: 11,
  aralik: 12,
  aralık: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const GENERIC_LOCATION_HEADINGS = new Set([
  'namaz vakitleri',
  'prayer times',
]);

export class ParseError extends Error {}
export class YearMismatchError extends ParseError {}

export interface ParsedLocation {
  diyanetLocationId: number;
  locale: string;
  slug: string;
  displayName: string;
  countryName: string | null;
  cityName: string | null;
  districtName: string | null;
  latitude: number | null;
  longitude: number | null;
  sourceUrl: string;
}

export interface ParsedPrayerDay {
  prayerDate: string; // YYYY-MM-DD
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
}

export interface ParsedRegItem {
  itemId: number;
  name: string;
}

function extractLocNodes(xml: string): string[] {
  const $ = load(xml, { xmlMode: true });
  const urls: string[] = [];
  $('loc').each((_: number, el: any) => {
    const text = $(el).text().trim();
    if (text) urls.push(text);
  });
  return urls;
}

export function parseSitemapIndex(xml: string): string[] {
  return extractLocNodes(xml);
}

export function parseLocationSitemap(xml: string): string[] {
  const urls = extractLocNodes(xml);
  return urls.filter((url) => LOCATION_URL_RE.test(url));
}

export function parseLocationUrl(
  url: string,
): { locale: string; locationId: number; slug: string } {
  const parsed = new URL(url, 'https://placeholder.com');
  const match = LOCATION_URL_RE.exec(parsed.pathname);
  if (!match || !match.groups) throw new ParseError(`Location URL cannot be parsed: ${url}`);
  const locationId = parseInt(match.groups.id, 10);
  const slug = match.groups.slug || `location-${locationId}`;
  return { locale: match.groups.locale, locationId, slug };
}

function tryInt(value: unknown): number | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = parseInt(text, 10);
  if (isNaN(num) || num <= 0) return null;
  return num;
}

export function parseSelectItems(
  html: string,
  selectKeys: string[],
): ParsedRegItem[] {
  const $ = load(html);
  let selectEl: ReturnType<typeof $> | null = null;

  for (const key of selectKeys) {
    const byId = $(`select#${key}`);
    if (byId.length) {
      selectEl = byId;
      break;
    }
    const byName = $(`select[name="${key}"]`);
    if (byName.length) {
      selectEl = byName;
      break;
    }
  }

  if (!selectEl || !selectEl.length) {
    selectEl = $('select').first();
    if (!selectEl.length) return [];
  }

  const items: ParsedRegItem[] = [];
  const seen = new Set<number>();

  selectEl.find('option').each((_: number, el: any) => {
    const itemId = tryInt($(el).attr('value'));
    if (itemId == null || seen.has(itemId)) return;
    const name = normalizeSpaces($(el).text().trim());
    if (!name) return;
    seen.add(itemId);
    items.push({ itemId, name });
  });

  return items;
}

export function parseRegListItems(payloadText: string): ParsedRegItem[] {
  const stripped = payloadText.trim();
  if (!stripped) return [];

  if (stripped.toLowerCase().includes('<option') || stripped.startsWith('<')) {
    return parseSelectItems(`<select>${stripped}</select>`, ['dynamic']);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch {
    return [];
  }

  const candidates: Record<string, unknown>[] = [];

  function collect(obj: unknown): void {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          candidates.push(item as Record<string, unknown>);
          collect(item);
        } else if (Array.isArray(item)) {
          collect(item);
        } else if (typeof item === 'string' && item.toLowerCase().includes('<option')) {
          for (const parsed of parseRegListItems(item)) {
            candidates.push({ Value: parsed.itemId, Text: parsed.name });
          }
        }
      }
      return;
    }
    if (typeof obj === 'object' && obj !== null) {
      candidates.push(obj as Record<string, unknown>);
      for (const value of Object.values(obj as Record<string, unknown>)) {
        if (Array.isArray(value)) collect(value);
        else if (typeof value === 'object' && value !== null) collect(value);
        else if (typeof value === 'string' && value.toLowerCase().includes('<option')) {
          for (const parsed of parseRegListItems(value)) {
            candidates.push({ Value: parsed.itemId, Text: parsed.name });
          }
        }
      }
    }
  }

  collect(payload);

  const items: ParsedRegItem[] = [];
  const seen = new Set<number>();

  const priorityIdKeys = [
    'value', 'id', 'sehirid', 'stateid', 'countryid', 'ilceid', 'regid',
  ];
  const priorityNameKeys = [
    'text', 'name', 'adi', 'ad', 'label', 'sehiradi', 'ilceadi', 'regname',
  ];

  for (const item of candidates) {
    const lowered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      lowered[key.toLowerCase()] = value;
    }

    let itemId: number | null = null;
    for (const key of priorityIdKeys) {
      itemId = tryInt(lowered[key]);
      if (itemId != null) break;
    }
    if (itemId == null) {
      for (const [key, value] of Object.entries(lowered)) {
        if (key.endsWith('id')) {
          itemId = tryInt(value);
          if (itemId != null) break;
        }
      }
    }
    if (itemId == null || seen.has(itemId)) continue;

    let name = '';
    for (const key of priorityNameKeys) {
      const raw = lowered[key];
      if (raw == null) continue;
      name = normalizeSpaces(String(raw));
      if (name) break;
    }
    if (!name) {
      for (const [key, value] of Object.entries(lowered)) {
        if (key.endsWith('name') || key.endsWith('adi') || key.includes('text')) {
          name = normalizeSpaces(String(value));
          if (name) break;
        }
      }
    }
    if (!name) continue;

    seen.add(itemId);
    items.push({ itemId, name });
  }

  return items;
}

export function slugToDisplayName(slug: string): string {
  let cleaned = slug.replace(/-icin-namaz-vakti$/, '');
  cleaned = cleaned.replace(/-/g, ' ');
  return normalizeSpaces(
    cleaned.replace(/\b\w/g, (c) => c.toUpperCase()),
  );
}

export function detectPageYear(html: string): number | null {
  const $ = load(html);
  const candidates: number[] = [];

  for (const selector of ['title', 'h1', 'h2', 'strong']) {
    $(selector).each((_: number, el: any) => {
      const text = normalizeSpaces($(el).text().trim());
      if (!text) return;
      if (
        text.toLowerCase().includes('namaz') ||
        text.toLowerCase().includes('vakti') ||
        text.toLowerCase().includes('imsakiye')
      ) {
        const years = text.match(/\b20\d{2}\b/g);
        if (years) candidates.push(...years.map(Number));
      }
    });
  }

  if (candidates.length) return Math.max(...candidates);

  const earlyYears = html.slice(0, 4000).match(/\b20\d{2}\b/g);
  if (earlyYears?.length) return parseInt(earlyYears[0], 10);

  return null;
}

function extractSelectedOptionText(
  $: CheerioAPI,
  keys: string[],
): string | null {
  for (const key of keys) {
    let selectEl = $(`select#${key}`);
    if (!selectEl.length) selectEl = $(`select[name="${key}"]`);
    if (!selectEl.length) continue;

    let selected = selectEl.find('option[selected]');
    if (!selected.length) {
      selected = selectEl.find('option[selected="selected"]');
    }
    if (!selected.length) continue;

    const text = normalizeSpaces(selected.text().trim());
    if (text) return text;
  }
  return null;
}

function extractCoordinates(html: string): [number, number] | null {
  const toFloat = (v: string) => parseFloat(v.replace(',', '.'));
  const valid = (lat: number, lng: number) =>
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

  const num = String.raw`-?\d{1,3}(?:[.,]\d+)?`;

  const combinedPatterns = [
    new RegExp(
      `enlem\\s*[:=]\\s*['"]?(?<lat>${num})['"]?.{0,120}?boylam\\s*[:=]\\s*['"]?(?<lng>${num})`,
      'is',
    ),
    new RegExp(
      `lat(?:itude)?\\s*[:=]\\s*['"]?(?<lat>${num})['"]?.{0,120}?l(?:on|ng|ongitude)\\s*[:=]\\s*['"]?(?<lng>${num})`,
      'is',
    ),
    new RegExp(
      `LatLng\\(\\s*(?<lat>${num})\\s*,\\s*(?<lng>${num})\\s*\\)`,
      'i',
    ),
    new RegExp(
      `(?:center|koord|coord|konum|location|geo).{0,80}?(?<lat>${num})\\s*,\\s*(?<lng>${num})`,
      'is',
    ),
  ];

  for (const pattern of combinedPatterns) {
    const match = pattern.exec(html);
    if (!match?.groups) continue;
    const lat = toFloat(match.groups.lat);
    const lng = toFloat(match.groups.lng);
    if (valid(lat, lng)) return [lat, lng];
  }

  const latPattern = new RegExp(
    `(?:lat|latitude|enlem)\\s*[:=]\\s*['"]?(?<lat>${num})`,
    'i',
  );
  const lngPattern = new RegExp(
    `(?:lng|lon|longitude|boylam)\\s*[:=]\\s*['"]?(?<lng>${num})`,
    'i',
  );

  const latMatch = latPattern.exec(html);
  const lngMatch = lngPattern.exec(html);
  if (!latMatch?.groups || !lngMatch?.groups) return null;

  const lat = toFloat(latMatch.groups.lat);
  const lng = toFloat(lngMatch.groups.lng);
  if (valid(lat, lng)) return [lat, lng];

  return null;
}

export function parseLocationMetadata(
  html: string,
  sourceUrl: string,
): ParsedLocation {
  const { locale, locationId, slug } = parseLocationUrl(sourceUrl);
  const $ = load(html);

  const heading = $('h1').first();
  const headingText = heading.length
    ? normalizeSpaces(heading.text().trim())
    : '';

  let displayName = slugToDisplayName(slug);
  if (headingText) {
    const headingKey = normalizeLookup(headingText);
    const beforeSuffix = headingText.split(' için ')[0].trim();
    if (headingText.includes(' için ') && beforeSuffix) {
      displayName = beforeSuffix;
    } else if (GENERIC_LOCATION_HEADINGS.has(headingKey)) {
      // keep slug-derived
    } else {
      displayName = headingText;
    }
  }

  const countryName = extractSelectedOptionText($, [
    'CountryId',
    'countryId',
    'country',
  ]);
  let cityName = extractSelectedOptionText($, [
    'CityId',
    'cityId',
    'city',
  ]);
  const districtName = extractSelectedOptionText($, [
    'StateId',
    'stateId',
    'district',
  ]);

  if (cityName == null) cityName = displayName;

  const coords = extractCoordinates(html);

  return {
    diyanetLocationId: locationId,
    locale,
    slug,
    displayName,
    countryName,
    cityName,
    districtName,
    latitude: coords ? coords[0] : null,
    longitude: coords ? coords[1] : null,
    sourceUrl,
  };
}

function parseRowDate(cellText: string, year: number): string | null {
  const match = DATE_RE.exec(cellText);
  if (!match?.groups) return null;

  const day = parseInt(match.groups.day, 10);
  const monthName = match.groups.month;
  const monthKey = normalizeLookup(monthName);

  const month = MONTHS[monthName.toLowerCase()] ?? MONTHS[monthKey];
  if (!month) return null;

  const dayStr = String(day).padStart(2, '0');
  const monthStr = String(month).padStart(2, '0');
  const dateStr = `${year}-${monthStr}-${dayStr}`;

  // Validate it's a real date
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;

  return dateStr;
}

function parseClock(value: string): string {
  return value; // already HH:MM
}

export function parsePrayerTimesTable(
  html: string,
  requestedYear?: number,
): { rows: ParsedPrayerDay[]; parsedYear: number } {
  const $ = load(html);
  const detectedYear = detectPageYear(html);
  const year = requestedYear ?? detectedYear ?? new Date().getFullYear();

  if (
    requestedYear != null &&
    detectedYear != null &&
    requestedYear !== detectedYear
  ) {
    throw new YearMismatchError(
      `Requested year ${requestedYear} does not match page year ${detectedYear}`,
    );
  }

  const rows: ParsedPrayerDay[] = [];
  $('tr').each((_: number, tr: any) => {
    const tds = $(tr)
      .find('td')
      .map((__: number, td: any) => normalizeSpaces($(td).text().trim()))
      .get();
    if (tds.length < 3) return;

    const prayerDate = parseRowDate(tds[0], year);
    if (!prayerDate) return;

    const timeStr = tds.slice(1).join(' ');
    const times: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(TIME_RE.source, 'g');
    while ((m = re.exec(timeStr)) !== null) times.push(m[0]);
    if (times.length < 6) return;

    rows.push({
      prayerDate,
      fajr: parseClock(times[0]),
      sunrise: parseClock(times[1]),
      dhuhr: parseClock(times[2]),
      asr: parseClock(times[3]),
      maghrib: parseClock(times[4]),
      isha: parseClock(times[5]),
    });
  });

  if (!rows.length) throw new ParseError('Prayer table could not be parsed from HTML');

  const byDate = new Map<string, ParsedPrayerDay>();
  for (const row of rows) byDate.set(row.prayerDate, row);
  const orderedRows = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, r]) => r);

  return { rows: orderedRows, parsedYear: detectedYear ?? year };
}
