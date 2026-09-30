const koreaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessDate(now = new Date()): string {
  // ICU/CLDR versions can format en-CA as either YYYY-MM-DD or MM/DD/YYYY.
  const parts = koreaDate.formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}

export function businessDateAfter(days: number, now = new Date()): string {
  // Calendar arithmetic is performed on the Korean business date, independent of host timezone.
  const date = new Date(`${businessDate(now)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
