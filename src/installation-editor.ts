import { installationBooleanChoice, installationComparableValue } from './installation-client';
import type { InstallationSectionDraft } from './installation-client';
import type {
  InstallationDetailField,
  InstallationDetails,
  InstallationSectionId,
} from './installation-types';

type Group = { id: string; title: string; keys: readonly string[] };
const group = (id: string, title: string, keys: string): Group => ({ id, title, keys: keys.split(' ') });
const groups: Record<InstallationSectionId, Group[]> = {
  installation: [
    group('basic', '기본 정보', 'systemCode serviceVersion sv_version sys_cd ct_cd mng_cd setup_year'),
    group(
      'history',
      '설치 이력',
      'version installedAt patchedAt engineer setup_date last_setup_date setup_engineer yeta_version',
    ),
    group(
      'operation',
      '운영 정보',
      'accessType autoUpdate domain autoupdate_yn bonding_yn sys_member sys_com_count',
    ),
    group('notes', '비고', 'note ct_etc setup_etc'),
  ],
  access: [
    group(
      'network',
      '연결 정보',
      'access_type domainurl ssh_port external_ip internal_ip netmask gateway dns1 dns2',
    ),
    group('ssl', 'SSL 설정', 'ssl_apply_yn ssl_manage_type ssl_applydate ssl_pwd'),
    group('vpn', 'VPN 계정', 'vpnsv_ip vpnsv_id vpnsv_pwd'),
    group('os', 'OS 계정', 'rootpath os_root_id os_root_pwd os_user_id os_user_pwd os_login_etc'),
    group('notes', '비고·참고사항', 'access_etc'),
  ],
  server: [
    group('device', '서버 장비', 'hostname servicetag express_service_code model'),
    group('location', '설치 장소 및 이력', 'zipcode address migration_date migration_engineer'),
  ],
  yeta: [
    group('system', '시스템 정보', 'sys_cd yeta_year ct_cd app_type comcode'),
    group('account', '로그인 계정', 'yeta_id yeta_pwd'),
  ],
  sap: [
    group('system', 'SAP 연결', 'sys_cd app_type app_ip sysnr r3name client lang'),
    group('account', '로그인 계정', 'sap_id sap_pwd gr_id gr_pwd'),
    group('notes', '비고', 'etc'),
  ],
  settings: [group('settings', '설정 정보', 'setting_year setting_type setting_yn setting_etc')],
  files: [group('files', '설정 정보', 'system_code att_year set_name set_value')],
};
const other: Group = { id: 'other', title: '기타 항목', keys: [] };
export const installationFieldGroup = (section: InstallationSectionId, key: string) =>
  groups[section].find((item) => item.keys.includes(key)) ?? other;
export function installationEditorGroups(section: InstallationSectionId, keys: string[], notes = false) {
  const present = new Set(keys.map((key) => installationFieldGroup(section, key).id));
  if (section === 'access' && notes) present.add('notes');
  return [...groups[section], other].filter((item) => present.has(item.id));
}

const dates = new Set([
  'installedAt',
  'patchedAt',
  'setup_date',
  'last_setup_date',
  'ssl_applydate',
  'migration_date',
]);
const numbers = new Set([
  'ssh_port',
  'setup_year',
  'yeta_year',
  'setting_year',
  'att_year',
  'sys_member',
  'sys_com_count',
]);
const choices: Record<string, readonly string[]> = {
  serviceVersion: ['Cloud', 'On Premises', 'SAP'],
  sv_version: ['Cloud', 'On Premises', 'SAP'],
  accessType: ['알 수 없음', '바로 접근', '원격', '불가', 'VPN/VDI'],
};
export function installationLongField(key: string, value: string) {
  return /note|etc|description|set_value/i.test(key) || /[\n\r]/.test(value) || value.length > 150;
}
export function installationInputDefinition(key: string, original: string, expanded = false) {
  if (expanded || installationLongField(key, original)) return { type: 'textarea' as const };
  const boolean = installationBooleanChoice(key, original);
  if (boolean) return { type: 'boolean' as const, boolean };
  if (choices[key]) return { type: 'select' as const, options: choices[key] };
  // Imported dates/numbers may be noncanonical. Keep those exact values editable as text.
  if (
    dates.has(key) &&
    (!original ||
      (/^\d{4}-\d{2}-\d{2}$/.test(original) &&
        !original.startsWith('0000-') &&
        Number.isFinite(Date.parse(original)) &&
        new Date(original).toISOString().slice(0, 10) === original))
  )
    return { type: 'date' as const };
  if (numbers.has(key) && (!original || /^(0|[1-9]\d*)$/.test(original))) return { type: 'number' as const };
  return { type: 'text' as const };
}
export function installationFieldChanged(field: InstallationDetailField, values: Record<string, string>) {
  return (
    Object.hasOwn(values, field.id) &&
    (field.masked || installationComparableValue(field) !== values[field.id])
  );
}
export function installationSectionChangeCount(
  details: InstallationDetails,
  sectionId: InstallationSectionId,
  draft: InstallationSectionDraft,
) {
  const section = details.sections.find((item) => item.id === sectionId);
  return (
    (section?.rows.reduce(
      (count, row) =>
        count +
        row.fields.filter((field) => installationFieldChanged(field, draft.values)).length +
        Number(Object.hasOwn(draft.titles, row.id) && draft.titles[row.id] !== (row.title ?? section.title)),
      0,
    ) ?? 0) +
    (sectionId === 'access'
      ? (details.accessNotes ?? []).filter(
          (note) =>
            Object.hasOwn(draft.notes, note.id) && (note.masked || draft.notes[note.id] !== note.content),
        ).length
      : 0)
  );
}

export const installationBasicKeys = [
  'companyId',
  'companyName',
  'systemCode',
  'serviceVersion',
  'version',
  'installedAt',
  'patchedAt',
  'engineer',
  'accessType',
  'autoUpdate',
  'domain',
  'note',
] as const;
export type InstallationBasicDraft = Partial<
  Record<Exclude<(typeof installationBasicKeys)[number], 'autoUpdate' | 'companyId'>, string>
> & { companyId?: string | null; autoUpdate?: boolean };
export const installationBasicChanges = (draft: InstallationBasicDraft, original: InstallationBasicDraft) =>
  installationBasicKeys.filter((key) => (draft[key] ?? '') !== (original[key] ?? ''));
export function installationBasicErrors(
  draft: InstallationBasicDraft,
  companyRequired: boolean,
  original?: InstallationBasicDraft,
) {
  const errors: Partial<Record<(typeof installationBasicKeys)[number], string>> = {};
  if (companyRequired && !(draft.companyId || draft.companyName?.trim()))
    errors.companyName = '고객사를 선택하거나 고객사명을 입력해 주세요.';
  if (!draft.systemCode?.trim()) errors.systemCode = '시스템 코드를 입력해 주세요.';
  if (
    draft.installedAt &&
    draft.patchedAt &&
    draft.patchedAt < draft.installedAt &&
    (!original || draft.installedAt !== original.installedAt || draft.patchedAt !== original.patchedAt)
  )
    errors.patchedAt = '최근 패치일은 최초 설치일보다 빠를 수 없습니다.';
  if (
    draft.domain &&
    draft.domain !== original?.domain &&
    !/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(draft.domain)
  )
    errors.domain = '도메인 이름만 입력해 주세요. 예: service.example.com';
  return errors;
}
