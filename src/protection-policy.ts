import { canManageBusiness } from './permissions.ts';

/** Disclosure follows the business role; system administration is a separate permission. */
export function canViewProtectedInformation(
  user: { role: string; status: string } | null | undefined,
): boolean {
  return canManageBusiness(user);
}
