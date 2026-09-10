const koreaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessDate(now = new Date()): string {
  return koreaDate.format(now);
}

export function businessDateAfter(days: number, now = new Date()): string {
  // Calendar arithmetic is performed on the Korean business date, independent of host timezone.
  const date = new Date(`${businessDate(now)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
