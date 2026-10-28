type InstallationSortRow = {
  systemCode?: string;
  updatedAt?: string;
  createdAt?: string;
};

const minimumYear = 1990;
const maximumYear = 2099;

/**
 * Largest plausible install year (1990–2099) inside a system code. A longer digit run is scanned
 * window by window, so `SYS-20260001` still yields 2026 while `DEMO-SYS-12` yields nothing.
 */
export function installationSystemCodeYear(code: string | undefined): number | undefined {
  let year: number | undefined;
  for (const run of (code ?? '').match(/\d+/g) ?? [])
    for (let start = 0; start + 4 <= run.length; start += 1) {
      const value = Number(run.slice(start, start + 4));
      if (value >= minimumYear && value <= maximumYear && (year === undefined || value > year)) year = value;
    }
  return year;
}

/** Digit runs compare by value, so SYS-2 precedes SYS-10 without depending on locale data. */
const compareDigits = (left: string, right: string) => {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
};

export function compareSystemCode(left: string, right: string) {
  const a = left.match(/\d+|\D+/g) ?? [];
  const b = right.match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (/^\d/.test(a[index]) && /^\d/.test(b[index])) {
      const digits = compareDigits(a[index], b[index]);
      if (digits) return digits;
    } else if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Installations: newest system-code year first, oldest year last. Rows without a year stay after
 * every dated row and keep the previous most-recently-updated-first order; any remaining tie falls
 * back to the system code, so the list never reshuffles between loads.
 */
export function sortInstallations<T extends InstallationSortRow>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const a = installationSystemCodeYear(left.systemCode);
    const b = installationSystemCodeYear(right.systemCode);
    if (a !== b) {
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      return b - a;
    }
    if (a === undefined) {
      const recent = (right.updatedAt || right.createdAt || '').localeCompare(
        left.updatedAt || left.createdAt || '',
      );
      if (recent) return recent;
    }
    return compareSystemCode(left.systemCode ?? '', right.systemCode ?? '');
  });
}
