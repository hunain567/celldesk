export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const dateTime = new Intl.DateTimeFormat('en-PK', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** "5 minutes ago", "yesterday", "3 days ago" — falls back to the date for older times. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDateTime(iso);
}

const kindLabels: Record<string, string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  'pre-restore': 'Before restore',
  'pre-update': 'Before update',
};

export function backupKindLabel(kind: string): string {
  return kindLabels[kind] ?? kind;
}

const timeOnly = new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat('en-PK', { weekday: 'short', day: 'numeric', month: 'short' });

/** "Today, 9:00 pm", "Tomorrow, 9:00 pm" or "Sun, 30 Nov, 9:00 pm" for times ahead. */
export function formatUpcoming(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  const time = timeOnly.format(date);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  return `${shortDate.format(date)}, ${time}`;
}
