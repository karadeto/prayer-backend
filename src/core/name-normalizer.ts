import { normalizeSpaces } from './text-utils';

const PARENS_RE = /\(([^)]+)\)/g;
const ALL_CAPS_RE = /^[A-ZÇĞİÖŞÜ\s.,'-]+$/;

/**
 * Converts ALL CAPS text to Title Case while preserving
 * short words like "St.", dashes, and apostrophes.
 */
function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(?:^|\s|[-/])(\S)/g, (match) => match.toUpperCase());
}

function normalizeCase(value: string): string {
  if (!value) return '';
  const trimmed = normalizeSpaces(value);
  if (ALL_CAPS_RE.test(trimmed)) return toTitleCase(trimmed);
  return trimmed;
}

export interface NormalizedName {
  /** Primary cleaned name (no parenthetical content) */
  primary: string;
  /** Content extracted from parentheses, if any */
  parenthetical: string | null;
  /** All useful name variants to try for geocoding (best first) */
  variants: string[];
}

/**
 * Normalizes a Diyanet location name for geocoding.
 *
 * Handles patterns like:
 *   "EBRACH (Wurzburg)"       → primary: "Ebrach",  parenthetical: "Wurzburg"
 *   "BRUNSWICK (BRAUNSCHWEIG)" → primary: "Brunswick", parenthetical: "Braunschweig"
 *   "BAD KISSINGEN"           → primary: "Bad Kissingen", parenthetical: null
 *   "KÖLN"                    → primary: "Köln",    parenthetical: null
 */
export function normalizeDiyanetName(raw: string): NormalizedName {
  if (!raw?.trim()) {
    return { primary: '', parenthetical: null, variants: [] };
  }

  const parenMatches: string[] = [];
  let cleaned = raw;
  let match: RegExpExecArray | null;
  const re = new RegExp(PARENS_RE.source, 'g');

  while ((match = re.exec(raw)) !== null) {
    const inner = normalizeSpaces(match[1]).trim();
    if (inner) parenMatches.push(inner);
  }

  cleaned = cleaned.replace(PARENS_RE, ' ');
  const primary = normalizeCase(normalizeSpaces(cleaned));

  if (!parenMatches.length) {
    return {
      primary,
      parenthetical: null,
      variants: primary ? [primary] : [],
    };
  }

  const parenthetical = normalizeCase(parenMatches.join(', '));

  const variants = buildVariants(primary, parenthetical);

  return { primary, parenthetical, variants };
}

function buildVariants(primary: string, parenthetical: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();

  const add = (v: string) => {
    const key = v.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      variants.push(v);
    }
  };

  // If the parenthetical looks like a local/alternative name for the same place
  // (single word or short phrase), it's often more recognizable to geocoders.
  // e.g. BRUNSWICK (BRAUNSCHWEIG) → "Braunschweig" is the real German name
  const isAlternativeName = !parenthetical.includes(',') &&
    parenthetical.split(/\s+/).length <= 3;

  if (isAlternativeName) {
    // Local name first — often the "real" name Google knows
    add(parenthetical);
    // Then the primary (transliterated) name
    add(primary);
  } else {
    // Parenthetical is a region hint (e.g. "Wurzburg")
    // Use primary + region as a compound query component
    add(`${primary}, ${parenthetical}`);
    add(primary);
    add(parenthetical);
  }

  return variants;
}
