import type { InstallationDetails } from './installation-types';
import type { InstallationSectionOperation } from './installation-client';

export type InstallationSaveFailure = {
  operation: InstallationSectionOperation;
  error: unknown;
  uncertain: boolean;
};

/** Execute one operation at a time and only acknowledge operations with a valid response. */
export async function runInstallationSavePlan(
  operations: InstallationSectionOperation[],
  initial: InstallationDetails,
  execute: (
    operation: InstallationSectionOperation,
    latest: InstallationDetails,
  ) => Promise<InstallationDetails>,
  onCommitted: (
    operation: InstallationSectionOperation,
    latest: InstallationDetails,
    previous: InstallationDetails,
  ) => void,
  isUncertain: (error: unknown) => boolean,
): Promise<{ latest: InstallationDetails; saved: number; failure?: InstallationSaveFailure }> {
  let latest = initial;
  let saved = 0;
  for (const operation of operations) {
    const previous = latest;
    try {
      latest = await execute(operation, latest);
      saved += 1;
      onCommitted(operation, latest, previous);
    } catch (error) {
      return { latest, saved, failure: { operation, error, uncertain: isUncertain(error) } };
    }
  }
  return { latest, saved };
}
