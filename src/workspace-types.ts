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
export const workspaceNameMaxLength = 60;
export const defaultWorkspaceBranding = {
  brandName: 'ieumdesk',
  workspaceName: 'Workspace',
} as const;
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
  protectionEnabled: boolean;
  menus: Record<MenuKey, boolean>;
  updatedAt: string;
};
export type WorkspaceSettingsPatch = {
  revision: number;
  brandName?: string;
  workspaceName?: string;
  protectionEnabled?: boolean;
  menus?: Partial<Record<MenuKey, boolean>>;
};
export const defaultWorkspaceSettings = (): WorkspaceSettings => ({
  ...defaultWorkspaceBranding,
  revision: 1,
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
