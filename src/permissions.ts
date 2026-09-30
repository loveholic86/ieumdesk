type Account = { role: string; status: string };

export const hasBusinessRole = (role: string | undefined): boolean =>
  role === 'admin' || role === 'editor';

/** Administrators and editors share business operations, including approvals and files. */
export const canManageBusiness = (user: Account | null | undefined): boolean =>
  user?.status === 'active' && hasBusinessRole(user.role);

/** User/role administration and workspace settings remain administrator-only. */
export const canManageSystem = (user: Account | null | undefined): boolean =>
  user?.status === 'active' && user.role === 'admin';
