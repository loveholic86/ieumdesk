import type { InstallationDetails, InstallationDetailRow, InstallationSectionId } from './installation-types';
import type {
  InstallationSectionDraft,
  InstallationSectionOperation,
  NewInstallationField,
} from './installation-client';

type AddedRowDraft = NonNullable<InstallationSectionDraft['addedRows']>[number];
type AddedFieldDraft = NonNullable<InstallationSectionDraft['addedFields']>[string][number];

export type InstallationDraftRef = { current: InstallationSectionDraft };

/** Commit the latest React draft ref, which may differ from the snapshot that was sent. */
export function commitLatestInstallationDraft(
  draftRef: InstallationDraftRef,
  operation: InstallationSectionOperation,
  before: InstallationDetails,
  after: InstallationDetails,
): InstallationSectionDraft {
  const next = reconcileCommittedInstallationDraft(draftRef.current, operation, before, after);
  draftRef.current = next;
  return next;
}

export function installationReviewValue(value: string, protectedValue: boolean): string | undefined {
  return protectedValue && value ? undefined : value;
}

export function installationNoteReviewEntries(
  notes: NonNullable<InstallationDetails['accessNotes']>,
  removedIds: string[],
) {
  return notes.map((note, index) => ({ note, index })).filter(({ note }) => removedIds.includes(note.id));
}

function section(details: InstallationDetails, id: InstallationSectionId) {
  return details.sections.find((item) => item.id === id);
}
function rowFor(details: InstallationDetails, id: string) {
  return details.sections.flatMap((item) => item.rows).find((row) => row.id === id);
}
function withoutRecord<T>(record: Record<string, T>, id: string) {
  const { [id]: _removed, ...rest } = record;
  return rest;
}
function addUnique(items: string[], item: string) {
  return items.includes(item) ? items : [...items, item];
}

/** Acknowledge only the part of the current draft represented by a confirmed request snapshot. */
export function reconcileCommittedInstallationDraft(
  current: InstallationSectionDraft,
  operation: InstallationSectionOperation,
  before: InstallationDetails,
  after: InstallationDetails,
): InstallationSectionDraft {
  const next: InstallationSectionDraft = {
    ...current,
    values: { ...current.values },
    titles: { ...current.titles },
    notes: { ...current.notes },
    addedRows: [...(current.addedRows ?? [])],
    removedRows: [...(current.removedRows ?? [])],
    addedFields: Object.fromEntries(
      Object.entries(current.addedFields ?? {}).map(([id, fields]) => [id, [...fields]]),
    ),
    removedFields: Object.fromEntries(
      Object.entries(current.removedFields ?? {}).map(([id, fields]) => [id, [...fields]]),
    ),
    addedNotes: [...(current.addedNotes ?? [])],
    removedNotes: [...(current.removedNotes ?? [])],
  };

  if (operation.kind === 'row-update') {
    const beforeRow = rowFor(before, operation.id);
    const afterRow = rowFor(after, operation.id);
    if (beforeRow && afterRow) {
      for (const [key, submitted] of Object.entries(operation.body.values ?? {})) {
        const field = afterRow.fields.find((item) => item.key === key);
        if (field && Object.hasOwn(next.values, field.id) && next.values[field.id] === submitted)
          delete next.values[field.id];
      }
      if (operation.body.title !== undefined && next.titles[operation.id] === operation.body.title)
        delete next.titles[operation.id];
      if (operation.body.removeFields?.length) {
        next.removedFields![operation.id] = (next.removedFields![operation.id] ?? []).filter(
          (key) => !operation.body.removeFields!.includes(key),
        );
      }
      const submittedFields = operation.body.addFields ?? [];
      const currentFields = next.addedFields![operation.id] ?? [];
      const remainingFields = [...currentFields];
      submittedFields.forEach((submitted, index) => {
        const localId = operation.addFieldLocalIds[index];
        const pending = currentFields.find((field) => field.localId === localId);
        const saved = afterRow.fields.find((field) => field.key === submitted.key);
        if (!saved) return;
        if (!pending) {
          next.removedFields![operation.id] = addUnique(
            next.removedFields![operation.id] ?? [],
            submitted.key,
          );
          return;
        }
        if (pending.key === submitted.key && pending.label === submitted.label) {
          const pendingIndex = remainingFields.findIndex((field) => field.localId === localId);
          if (pendingIndex !== -1) remainingFields.splice(pendingIndex, 1);
          if (pending.value !== submitted.value) next.values[saved.id] = pending.value;
        } else {
          next.removedFields![operation.id] = addUnique(
            next.removedFields![operation.id] ?? [],
            submitted.key,
          );
        }
      });
      if (submittedFields.length) next.addedFields![operation.id] = remainingFields;
    }
    return next;
  }

  if (operation.kind === 'row-create') {
    const beforeIds = new Set(section(before, operation.body.sectionId)?.rows.map((row) => row.id) ?? []);
    const created = (section(after, operation.body.sectionId)?.rows ?? []).filter(
      (row) => !beforeIds.has(row.id),
    );
    if (created.length !== 1) return next; // Keep the draft if the server result cannot be mapped unambiguously.
    const saved = created[0];
    const pending = next.addedRows!.find((row) => row.localId === operation.localId);
    next.addedRows = next.addedRows!.filter((row) => row.localId !== operation.localId);
    if (!pending) {
      next.removedRows = addUnique(next.removedRows!, saved.id);
      return next;
    }
    if (pending.title !== saved.title) next.titles[saved.id] = pending.title;
    const pendingFields = new Map(pending.fields.map((field) => [field.localId ?? '', field]));
    const submittedByLocal = new Map<string, NewInstallationField>();
    operation.body.fields.forEach((field, index) =>
      submittedByLocal.set(operation.fieldLocalIds[index] ?? '', field),
    );
    const extraFields: AddedFieldDraft[] = [];
    const removed: string[] = [];
    for (const [localId, submitted] of submittedByLocal) {
      const currentField = pendingFields.get(localId);
      const savedField = saved.fields.find((field) => field.key === submitted.key);
      if (!currentField) {
        removed.push(submitted.key);
      } else if (currentField.key === submitted.key && currentField.label === submitted.label) {
        if (savedField && currentField.value !== submitted.value)
          next.values[savedField.id] = currentField.value;
      } else {
        removed.push(submitted.key);
        extraFields.push({ ...currentField, localId: currentField.localId ?? `reconciled-${submitted.key}` });
      }
      pendingFields.delete(localId);
    }
    extraFields.push(
      ...[...pendingFields.values()].map((field) => ({
        ...field,
        localId: field.localId ?? `reconciled-${field.key}`,
      })),
    );
    if (removed.length)
      next.removedFields![saved.id] = [...new Set([...(next.removedFields![saved.id] ?? []), ...removed])];
    if (extraFields.length)
      next.addedFields![saved.id] = [...(next.addedFields![saved.id] ?? []), ...extraFields];
    return next;
  }

  if (operation.kind === 'row-delete') {
    const beforeRow = rowFor(before, operation.id);
    if (beforeRow && !next.removedRows!.includes(operation.id)) {
      // The user restored the pending deletion while the request outcome was unknown.
      const localId = `restored-${operation.id}`;
      const fields = beforeRow.fields
        .filter((field) => !field.masked)
        .map((field) => ({
          localId: `${localId}-${field.key}`,
          key: field.key,
          label: field.label,
          value: next.values[field.id] ?? field.value,
        }));
      next.addedRows!.push({ localId, title: next.titles[operation.id] ?? beforeRow.title ?? '', fields });
    }
    next.removedRows = next.removedRows!.filter((id) => id !== operation.id);
    for (const field of beforeRow?.fields ?? []) delete next.values[field.id];
    delete next.titles[operation.id];
    next.addedFields = withoutRecord(next.addedFields!, operation.id);
    next.removedFields = withoutRecord(next.removedFields!, operation.id);
    return next;
  }

  if (operation.kind === 'note-update') {
    if (next.notes[operation.id] === operation.content) delete next.notes[operation.id];
    return next;
  }
  if (operation.kind === 'note-create') {
    const beforeIds = new Set((before.accessNotes ?? []).map((note) => note.id));
    const created = (after.accessNotes ?? []).filter((note) => !beforeIds.has(note.id));
    if (created.length !== 1) return next;
    const saved = created[0];
    const pending = next.addedNotes!.find((note) => note.localId === operation.localId);
    next.addedNotes = next.addedNotes!.filter((note) => note.localId !== operation.localId);
    if (!pending) next.removedNotes = addUnique(next.removedNotes!, saved.id);
    else if (pending.content !== operation.content) next.notes[saved.id] = pending.content;
    return next;
  }
  if (operation.kind === 'note-delete') {
    if (!next.removedNotes!.includes(operation.id)) {
      const old = (before.accessNotes ?? []).find((note) => note.id === operation.id);
      const restored = Object.hasOwn(next.notes, operation.id)
        ? next.notes[operation.id]
        : old && !old.masked
          ? old.content
          : '';
      if (restored) next.addedNotes!.push({ localId: `restored-${operation.id}`, content: restored });
    }
    next.removedNotes = next.removedNotes!.filter((id) => id !== operation.id);
    delete next.notes[operation.id];
    return next;
  }
  return next;
}
