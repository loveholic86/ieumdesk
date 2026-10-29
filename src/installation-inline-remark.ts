import { accessCommonSaveTarget } from './installation-client';
import {
  accessCommonRowId,
  accessEtcKey,
  type InstallationDetailField,
  type InstallationDetails,
  type InstallationSectionId,
} from './installation-types';

/**
 * Remark keys the read cards edit in place. Every other field keeps the full 「정보 수정」 form,
 * and a password-like key can never reach this list: membership is by key, never by `secret`.
 */
export const inlineRemarkKeys = new Set<string>(['note', 'ct_etc', 'setup_etc', accessEtcKey]);

/** The installation tab owns note/ct_etc/setup_etc; only the access tab owns access_etc. */
export function installationInlineRemarkField(
  sectionId: InstallationSectionId,
  field: Pick<InstallationDetailField, 'key'>,
) {
  if (sectionId === 'access') return field.key === accessEtcKey;
  if (sectionId === 'installation') return field.key !== accessEtcKey && inlineRemarkKeys.has(field.key);
  return false;
}

/** A protected remark reads as a mask, so its draft starts blank and a blank draft keeps it. */
export function inlineRemarkMasked(
  field: Pick<InstallationDetailField, 'masked' | 'secret'>,
  policyPending: boolean,
) {
  return field.masked || (policyPending && field.secret);
}

/** Remarks are free text, so they are edited in a textarea even while the stored value is short. */
export function inlineRemarkMultiline(field: Pick<InstallationDetailField, 'key'>) {
  return inlineRemarkKeys.has(field.key);
}

/** Server-side limits: a metadata `note` is a 10,000-character record field, other remarks 16,384. */
export function inlineRemarkMaxLength(field: Pick<InstallationDetailField, 'key'>) {
  return field.key === 'note' ? 10_000 : 16_384;
}

/** Only a real change may reach the API: an unprotected blank draft clears, a protected one keeps. */
export function inlineRemarkDirty(
  field: Pick<InstallationDetailField, 'value' | 'masked' | 'secret'>,
  draft: string,
  policyPending: boolean,
) {
  return inlineRemarkMasked(field, policyPending) ? draft !== '' : draft !== field.value;
}

export type InlineRemarkKeyAction = 'commit' | 'cancel' | 'newline' | 'ignore';

/**
 * Park/Chakra Editable contract: Escape reverts, Enter saves a single line, ⌘/Ctrl+Enter saves a
 * textarea while a bare Enter inserts a newline. An IME composition never triggers either.
 */
export function inlineRemarkKeyAction(input: {
  key: string;
  multiline: boolean;
  modifier: boolean;
  composing: boolean;
}): InlineRemarkKeyAction {
  if (input.composing) return 'ignore';
  if (input.key === 'Escape') return 'cancel';
  if (input.key !== 'Enter') return 'ignore';
  if (!input.multiline) return 'commit';
  return input.modifier ? 'commit' : 'newline';
}

export type InlineRemarkState = {
  phase: 'preview' | 'editing' | 'saving';
  /** Text the session started from, so Escape reverts to exactly what the user saw. */
  baseline: string;
  draft: string;
  /** A protected remark keeps its stored value when the draft stays blank. */
  masked: boolean;
};

export const inlineRemarkPreview = (baseline = '', masked = false): InlineRemarkState => ({
  phase: 'preview',
  baseline,
  draft: baseline,
  masked,
});

export type InlineRemarkReduceAction =
  | { type: 'open'; baseline: string; masked?: boolean }
  | { type: 'input'; draft: string }
  /** `stored` is the value on screen right now, so a background refresh is never overwritten. */
  | { type: 'confirm'; stored: string }
  | { type: 'escape' }
  | { type: 'settled' };

/**
 * The whole Editable session, as one pure step. `send` appears only on the single transition that
 * must call the API, so Escape, a blur without a change, and a repeated Enter can never send twice.
 */
export function inlineRemarkReduce(
  state: InlineRemarkState,
  action: InlineRemarkReduceAction,
): { state: InlineRemarkState; send?: string } {
  switch (action.type) {
    case 'open':
      // An open while a session runs is ignored: the owner closes the previous session first.
      if (state.phase !== 'preview') return { state };
      return {
        state: {
          phase: 'editing',
          baseline: action.baseline,
          draft: action.baseline,
          masked: action.masked ?? state.masked,
        },
      };
    case 'input':
      return state.phase === 'editing' ? { state: { ...state, draft: action.draft } } : { state };
    case 'confirm':
      // Also swallows the blur that follows an Escape or a commit, because those leave `editing`.
      if (state.phase !== 'editing') return { state };
      if (state.masked ? state.draft === '' : state.draft === action.stored)
        return { state: inlineRemarkPreview(action.stored, state.masked) };
      return { state: { ...state, phase: 'saving' }, send: state.draft };
    case 'escape':
      return state.phase === 'editing'
        ? { state: inlineRemarkPreview(state.baseline, state.masked) }
        : { state };
    case 'settled':
      // Saved or not, the stored value is what the card shows next; the owner re-reads the details.
      return { state: inlineRemarkPreview(state.baseline, state.masked) };
  }
}

export type InlineRemarkPlan =
  | { kind: 'metadata' | 'row'; rowId: string; values: Record<string, string> }
  | {
      kind: 'access-common-create';
      title: string;
      fields: { key: string; label: string; value: string }[];
    };

/**
 * The one-field save plan for an inline remark. Undefined when the draft matches what is stored, so
 * a blur without a change never sends a request, and a key outside this phase can never be saved.
 */
export function installationInlineRemarkPlan(
  details: InstallationDetails,
  sectionId: InstallationSectionId,
  field: InstallationDetailField,
  draft: string,
  policyPending: boolean,
): InlineRemarkPlan | undefined {
  if (!installationInlineRemarkField(sectionId, field)) return undefined;
  if (!inlineRemarkDirty(field, draft, policyPending)) return undefined;
  if (field.key === accessEtcKey) {
    // The shared remark always resolves through the common slot, never a server row's own value.
    const rows = details.sections.find((item) => item.id === 'access')?.rows ?? [];
    const target = accessCommonSaveTarget(rows);
    if (target.kind === 'create')
      return {
        kind: 'access-common-create',
        title: '설치 공통',
        fields: [
          {
            key: accessEtcKey,
            label: '접근 비고',
            value: draft,
          },
        ],
      };
    return { kind: 'row', rowId: target.rowId, values: { [accessEtcKey]: draft } };
  }
  const found = details.sections
    .find((section) => section.id === sectionId)
    ?.rows.find((row) => row.fields.some((item) => item.id === field.id));
  if (!found) return undefined;
  return {
    kind: found.managed === 'metadata' ? 'metadata' : 'row',
    rowId: found.id,
    values: { [field.key]: draft },
  };
}
