import {
  defaultWorkspaceSettings,
  menuDefinitions,
  resolveStartPage,
  type WorkspaceSettings,
} from './workspace-types';

export type View = (typeof menuDefinitions)[number][0] | 'account' | 'settings';
export const isView = (value: string): value is View =>
  value === 'account' || value === 'settings' || menuDefinitions.some(([key]) => key === value);

export function initialView(hash: string, settings: WorkspaceSettings = defaultWorkspaceSettings()): View {
  const page = hash.replace(/^#/, '');
  // Explicit links and refreshes retain the current page. A new login clears the old hash.
  return isView(page) ? page : resolveStartPage(settings);
}
