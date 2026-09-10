import type { CRMRecord, RecordKind } from '../src/types.ts';
import type { User } from './auth-store.ts';
import { mergeLegacyBusiness } from './business-legacy.ts';
import { metadataRow } from './installation-managed.ts';

export type BusinessArea = 'companies' | 'activities' | 'tasks' | 'products' | 'codes' | RecordKind;
export type BusinessDisclosureActor = Pick<User, 'id' | 'role' | 'status'>;
export type BusinessDisclosureSettings = { protectionEnabled: boolean };
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Public CRM fields remain available; protected content requires an active administrator and protection OFF. */
export function businessProtectionEnabled(actor: BusinessDisclosureActor, settings: BusinessDisclosureSettings): boolean {
  return settings.protectionEnabled !== false || actor.status !== 'active' || actor.role !== 'admin';
}

function standardText(value: string): string {
  // Reuse the established business disclosure classifier, including credential URLs and Korean markers.
  // It is a bounded credential-content rule, not a claim that arbitrary prose can be classified perfectly.
  const probe = { id: 'disclosure-classifier', note: value } as CRMRecord;
  return mergeLegacyBusiness(probe, {}, [], undefined, true).note;
}

function protectedTextTree(value: unknown): unknown {
  if (typeof value === 'string') return standardText(value);
  if (Array.isArray(value)) return value.map(protectedTextTree);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, protectedTextTree(nested)]));
}

/** Only response copies are masked. Internal records and metadata compare-and-swap fingerprints stay raw. */
export function projectBusinessDisclosure<T>(
  area: BusinessArea,
  payload: T,
  actor: BusinessDisclosureActor,
  settings: BusinessDisclosureSettings,
): T {
  const copy = structuredClone(payload);
  if (!businessProtectionEnabled(actor, settings)) return copy;
  const project = (value: unknown): unknown => {
    if (!object(value)) return value;
    const result = protectedTextTree(value) as Row;
    if (area === 'installations' && typeof value.id === 'string') {
      // The same definitions govern the installation list/CSV and its primary detail row.
      for (const field of metadataRow(value.id, value).fields) {
        if (Object.hasOwn(value, field.key) && field.secret && field.value) result[field.key] = '보호됨';
      }
    }
    return result;
  };
  if (Array.isArray(copy)) return copy.map(project) as T;
  if (object(copy) && !Object.hasOwn(copy, 'id') && Array.isArray(copy.items))
    return { ...copy, items: copy.items.map(project) } as T;
  return project(copy) as T;
}

/** Read policy after data I/O and again after rechecking the live session; a tightening wins within the request. */
export async function prepareBusinessDisclosure<T>(
  area: BusinessArea,
  payload: T,
  guard: {
    settings: () => Promise<BusinessDisclosureSettings>;
    assertActive: () => Promise<BusinessDisclosureActor>;
  },
): Promise<T> {
  const before = await guard.settings();
  const actor = await guard.assertActive();
  const current = await guard.settings();
  return projectBusinessDisclosure(area, payload, actor, {
    protectionEnabled: before.protectionEnabled !== false || current.protectionEnabled !== false,
  });
}
