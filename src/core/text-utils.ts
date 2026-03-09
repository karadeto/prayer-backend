const WHITESPACE_RE = /\s+/g;

export function normalizeSpaces(value: string): string {
  return value.replace(WHITESPACE_RE, ' ').trim();
}

export function normalizeLookup(value: string): string {
  let result = normalizeSpaces(value).toLowerCase();
  result = result.normalize('NFKD');
  return result.replace(/[\u0300-\u036f]/g, '');
}
