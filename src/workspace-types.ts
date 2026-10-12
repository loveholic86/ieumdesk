export const menuDefinitions = [
  ['overview', '업무 현황'],
  ['companies', '고객사 관리'],
  ['contacts', '담당자 관리'],
  ['activities', '활동 관리'],
  ['tasks', 'TASK 관리'],
  ['sales', '영업 관리'],
  ['quotations', '견적 관리'],
  ['installations', '설치 관리'],
  ['support', '고객지원'],
  ['users', '사용자 및 권한'],
] as const;
export type MenuKey = (typeof menuDefinitions)[number][0];
export const startPageDefinitions = [
  ...menuDefinitions.filter(
    (item): item is Exclude<(typeof menuDefinitions)[number], readonly ['users', '사용자 및 권한']> =>
      item[0] !== 'users',
  ),
  ['account', '내 계정'],
] as const;
export type StartPage = (typeof startPageDefinitions)[number][0];
export const defaultStartPage: StartPage = 'companies';
export const defaultSessionTimeoutMinutes = 12 * 60;
export const minSessionTimeoutMinutes = 1;
export const maxSessionTimeoutMinutes = 24 * 60;
export const validSessionTimeoutMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) &&
  value >= minSessionTimeoutMinutes && value <= maxSessionTimeoutMinutes;
export const validStartPage = (value: unknown): value is StartPage =>
  startPageDefinitions.some(([key]) => key === value);
export function resolveStartPage(settings: Pick<WorkspaceSettings, 'startPage' | 'menus'>): StartPage {
  const enabled = (page: StartPage) => page === 'account' || settings.menus[page];
  if (enabled(settings.startPage)) return settings.startPage;
  if (enabled(defaultStartPage)) return defaultStartPage;
  return startPageDefinitions.find(([page]) => enabled(page))?.[0] ?? 'account';
}
export const workspaceNameMaxLength = 60;
export const defaultWorkspaceBranding = {
  brandName: 'ieumdesk',
  workspaceName: 'Workspace',
} as const;
export type WorkspaceBranding = { brandName: string; workspaceName: string };
export function validWorkspaceBranding(value: unknown): value is WorkspaceBranding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const branding = value as Partial<WorkspaceBranding>;
  return validWorkspaceName(branding.brandName) && validWorkspaceName(branding.workspaceName);
}
export function validWorkspaceName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= workspaceNameMaxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  );
}
export type WorkspaceSettings = {
  revision: number;
  brandName: string;
  workspaceName: string;
  startPage: StartPage;
  sessionTimeoutMinutes: number;
  protectionEnabled: boolean;
  menus: Record<MenuKey, boolean>;
  updatedAt: string;
};
export type WorkspaceSettingsPatch = {
  revision: number;
  brandName?: string;
  workspaceName?: string;
  startPage?: StartPage;
  sessionTimeoutMinutes?: number;
  protectionEnabled?: boolean;
  menus?: Partial<Record<MenuKey, boolean>>;
};
export const defaultWorkspaceSettings = (): WorkspaceSettings => ({
  ...defaultWorkspaceBranding,
  revision: 1,
  startPage: defaultStartPage,
  sessionTimeoutMinutes: defaultSessionTimeoutMinutes,
  protectionEnabled: true,
  menus: Object.fromEntries(menuDefinitions.map(([key]) => [key, true])) as Record<MenuKey, boolean>,
  updatedAt: '',
});
export function validWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WorkspaceSettings>;
  return (
    Number.isSafeInteger(item.revision) &&
    Number(item.revision) > 0 &&
    validWorkspaceName(item.brandName) &&
    validWorkspaceName(item.workspaceName) &&
    validStartPage(item.startPage) &&
    validSessionTimeoutMinutes(item.sessionTimeoutMinutes) &&
    typeof item.protectionEnabled === 'boolean' &&
    typeof item.updatedAt === 'string' &&
    !!item.menus &&
    typeof item.menus === 'object' &&
    !Array.isArray(item.menus) &&
    menuDefinitions.every(([key]) => typeof item.menus?.[key] === 'boolean')
  );
}
export type WorkspaceAudit = {
  id: string;
  actorName: string;
  action: string;
  area: string;
  result: string;
  fields: string[];
  createdAt: string;
};
