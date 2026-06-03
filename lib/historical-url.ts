export const AS_OF_DATE_QUERY_PARAM = "asOfDate";

export function normalizeHistoricalDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function asOfDateQuery(asOfDate: string | null | undefined) {
  const normalized = normalizeHistoricalDate(asOfDate);
  return normalized ? `${AS_OF_DATE_QUERY_PARAM}=${encodeURIComponent(normalized)}` : "";
}

export function withAsOfDate(href: string, asOfDate: string | null | undefined) {
  const query = asOfDateQuery(asOfDate);
  if (!query) return href;
  if (href.includes(`${AS_OF_DATE_QUERY_PARAM}=`)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}
