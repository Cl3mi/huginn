// Utility formatters for dashboard display

export function formatPercent(value: number, decimals = 0): string {
  if (isNaN(value) || !isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

export function formatScore(value: number, max = 100): string {
  if (isNaN(value) || !isFinite(value)) return 'N/A';
  return `${value.toFixed(1)}/${max}`;
}

export function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-DE', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function truncateString(str: string, maxLength = 120): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural || `${singular}s`;
}
