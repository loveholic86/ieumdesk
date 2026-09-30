import type { InstallationDetailRow } from './installation-types';

export const installationConfigurationKeys = [
  // Preserve the original CRM download's byte order, not just its parsed values.
  'system_code',
  'att_year',
  'yeta_use_type',
  'system_max_user_count',
  'system_max_company_count',
  'simplepay_use',
  'simplepay_use_cnt',
] as const;
export type InstallationConfigurationKey = (typeof installationConfigurationKeys)[number];
export type InstallationConfiguration = Record<InstallationConfigurationKey, string>;

// YETA loads these counts with Java Integer.parseInt after uploading the file.
function count(value: string, label: string, minimum: number): string {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(trimmed) || trimmed.length > 20)
    throw new Error(
      `${label}${label.endsWith('수') ? '는' : '은'} ${minimum} 이상 2,147,483,647 이하의 정수로 입력해 주세요.`,
    );
  const normalized = trimmed.replace(/,/g, '');
  const number = Number(normalized);
  if (!Number.isInteger(number) || number < minimum || number > 2_147_483_647)
    throw new Error(
      `${label}${label.endsWith('수') ? '는' : '은'} ${minimum} 이상 2,147,483,647 이하의 정수로 입력해 주세요.`,
    );
  return normalized;
}

/** The download is made only from these explicit inputs, never arbitrary saved settings. */
export function normalizeInstallationConfiguration(input: unknown): InstallationConfiguration {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== installationConfigurationKeys.length ||
    installationConfigurationKeys.some(
      (key) => !Object.hasOwn(input, key) || typeof (input as Record<string, unknown>)[key] !== 'string',
    )
  )
    throw new Error('설정 파일의 7개 항목을 모두 입력해 주세요.');
  const values = input as InstallationConfiguration;
  const year = values.att_year.trim();
  const system = values.system_code.trim();
  if (!/^(19|20|21)\d{2}$/.test(year)) throw new Error('귀속 연도를 네 자리 숫자로 입력해 주세요.');
  if (!/^[\x21-\x7e]{1,80}$/.test(system) || /[,=]/.test(system))
    throw new Error('시스템 코드는 공백, 쉼표, 등호 없이 영문·숫자·기호로 입력해 주세요.');
  if (!['0', '1'].includes(values.yeta_use_type)) throw new Error('YETA 사용 유형을 선택해 주세요.');
  if (!['Y', 'N'].includes(values.simplepay_use))
    throw new Error('간이지급명세서 사용 여부를 선택해 주세요.');
  return {
    att_year: year,
    system_code: system,
    yeta_use_type: values.yeta_use_type,
    system_max_user_count: count(values.system_max_user_count, '최대 사용 인원', 1),
    system_max_company_count: count(values.system_max_company_count, '최대 회사 수', 1),
    simplepay_use: values.simplepay_use,
    // The customer upload screen also fixes this to zero when simplepay is disabled.
    simplepay_use_cnt:
      values.simplepay_use === 'N' ? '0' : count(values.simplepay_use_cnt, '간이지급명세서 사용 인원', 1),
  };
}

function visibleValue(row: InstallationDetailRow, key: string): string {
  const field = row.fields.find((field) => field.key === key);
  return field && !field.masked ? field.value : '';
}

export function installationConfigurationScopes(rows: InstallationDetailRow[]) {
  return rows
    .map((row) => ({ system: visibleValue(row, 'system_code'), year: visibleValue(row, 'att_year') }))
    .filter((scope) => scope.system && /^(19|20|21)\d{2}$/.test(scope.year));
}

export function installationConfigurationDraft(
  system: string,
  rows: InstallationDetailRow[],
  selectedYear?: string,
): InstallationConfiguration {
  const years = installationConfigurationScopes(rows)
    .filter((scope) => scope.system === system)
    .map((scope) => scope.year)
    .sort()
    .reverse();
  const currentYear = String(new Date().getFullYear());
  const year = selectedYear ?? (years.includes(currentYear) ? currentYear : (years[0] ?? currentYear));
  const draft: InstallationConfiguration = {
    att_year: year,
    system_code: system,
    yeta_use_type: '',
    system_max_user_count: '',
    system_max_company_count: '',
    simplepay_use: 'N',
    simplepay_use_cnt: '0',
  };
  const saved = new Map<string, Set<string>>();
  for (const row of rows) {
    if (visibleValue(row, 'system_code') !== system || visibleValue(row, 'att_year') !== year) continue;
    const key = visibleValue(row, 'set_name').replace(/^file_/, '');
    const value = visibleValue(row, 'set_value');
    if (!value) continue;
    if (!saved.has(key)) saved.set(key, new Set());
    saved.get(key)!.add(value);
  }
  for (const key of installationConfigurationKeys.slice(2)) {
    const candidates = saved.get(key);
    if (!candidates) continue;
    // Never arbitrarily choose a value from conflicting saved rows.
    draft[key] = candidates.size === 1 ? [...candidates][0] : '';
  }
  draft.yeta_use_type =
    ({ 일반: '1', 중도퇴사자: '0' } as Record<string, string>)[draft.yeta_use_type] ?? draft.yeta_use_type;
  draft.simplepay_use =
    ({ 예: 'Y', 아니오: 'N' } as Record<string, string>)[draft.simplepay_use] ?? draft.simplepay_use;
  if (draft.simplepay_use === 'N') draft.simplepay_use_cnt = '0';
  return draft;
}
