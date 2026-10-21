import type { InstallationSectionId } from './installation-types';

export type InstallationCodeGroup = 'access_type' | 'app_type' | 'setting_type' | 'ssl_manage_type';

export type InstallationCodeOption = {
  id: string;
  revision: number;
  active: boolean;
  group: InstallationCodeGroup;
  groupName: string;
  code: string;
  name: string;
  parentCode: string;
  numericValue: number | null;
};

const definitions: Record<
  InstallationCodeGroup,
  { groupName: string; sections: InstallationSectionId[]; key: string }
> = {
  access_type: { groupName: '접근 유형', sections: ['access'], key: 'access_type' },
  app_type: { groupName: '구분', sections: ['yeta', 'sap'], key: 'app_type' },
  setting_type: { groupName: '설정 종류', sections: ['settings'], key: 'setting_type' },
  ssl_manage_type: { groupName: 'SSL 관리 유형', sections: ['access'], key: 'ssl_manage_type' },
};

export const installationCodeGroups = Object.keys(definitions) as InstallationCodeGroup[];
export const installationCodeGroupsQuery = installationCodeGroups.join(',');

export function installationCodeGroupForField(
  section: InstallationSectionId,
  key: string,
  label?: string,
): InstallationCodeGroup | undefined {
  const group = installationCodeGroups.find((candidate) => {
    const definition = definitions[candidate];
    return definition.key === key && definition.sections.includes(section);
  });
  if (!group) return undefined;
  const expectedLabel = definitions[group].key === 'app_type' ? '구분' : definitions[group].groupName;
  return label === undefined || label === expectedLabel ? group : undefined;
}

export function installationCodeGroupName(group: InstallationCodeGroup) {
  return definitions[group].groupName;
}

/** Labels are shared with the whole workspace, so only short, non-sensitive categories are accepted. */
export function normalizeInstallationOptionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.normalize('NFC').trim();
  if (
    !name ||
    name.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    !/^[\p{L}\p{N} _()/+-]+$/u.test(name) ||
    /(?:https?:|www\.|password|passwd|secret|token|credential|account|username|비밀번호|비번|패스워드|토큰|계정|아이디|접속정보|로그인)/iu.test(
      name,
    )
  )
    return undefined;
  return name;
}

export function installationOptionNameKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

export type InstallationOptionRegistrationTarget = {
  recordId: string;
  sectionId: InstallationSectionId;
  targetId: string;
  fieldLabel: string;
  fieldValue: string;
};

export type InstallationOptionRegistrationAttempt = {
  id: string;
  group: InstallationCodeGroup;
  /** Immutable submitted value used for catalog checks and explicit retries. */
  name: string;
  /** The text shown in the control after it is reopened. */
  draftName: string;
  targets: InstallationOptionRegistrationTarget[];
  state: 'registering' | 'uncertain' | 'checking' | 'absent' | 'retrying' | 'found';
  option?: InstallationCodeOption;
  message?: string;
};

export function installationOptionTargetKey(target: InstallationOptionRegistrationTarget) {
  return JSON.stringify([target.recordId, target.sectionId, target.targetId]);
}

export function installationOptionRegistrationMatchesTarget(
  attempt: InstallationOptionRegistrationAttempt,
  target: InstallationOptionRegistrationTarget,
  group: InstallationCodeGroup,
  fieldLabel: string,
  fieldValue: string,
) {
  if (attempt.state !== 'found' || attempt.group !== group) return false;
  const submitted = attempt.targets.find(
    (item) => installationOptionTargetKey(item) === installationOptionTargetKey(target),
  );
  return Boolean(
    submitted &&
    submitted.fieldLabel === fieldLabel &&
    submitted.fieldValue === fieldValue &&
    submitted.recordId === target.recordId &&
    submitted.sectionId === target.sectionId &&
    submitted.targetId === target.targetId,
  );
}

/** Holds uncertain catalog writes across editor unmounts. It never retries POST without a confirmed absence. */
export class InstallationOptionRegistrationController {
  private attempts: InstallationOptionRegistrationAttempt[] = [];
  private listeners = new Set<() => void>();
  private inFlight = new Map<string, Promise<InstallationCodeOption | undefined>>();
  private sequence = 0;

  getSnapshot = () => this.attempts;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(attempts: InstallationOptionRegistrationAttempt[]) {
    this.attempts = attempts;
    for (const listener of this.listeners) listener();
  }

  private update(id: string, patch: Partial<InstallationOptionRegistrationAttempt>) {
    this.publish(this.attempts.map((attempt) => (attempt.id === id ? { ...attempt, ...patch } : attempt)));
  }

  async register(input: {
    group: InstallationCodeGroup;
    name: string;
    draftName: string;
    target: InstallationOptionRegistrationTarget;
    create: () => Promise<InstallationCodeOption>;
    isDefiniteFailure: (error: unknown) => boolean;
  }): Promise<InstallationCodeOption | undefined> {
    const key = installationOptionNameKey(input.name);
    const existing = this.attempts.find(
      (attempt) => attempt.group === input.group && installationOptionNameKey(attempt.name) === key,
    );
    if (existing) {
      const targetKey = installationOptionTargetKey(input.target);
      this.update(existing.id, {
        targets: existing.targets.some((target) => installationOptionTargetKey(target) === targetKey)
          ? existing.targets
          : [...existing.targets, input.target],
      });
      if (existing.state === 'registering') return this.inFlight.get(existing.id) ?? undefined;
      return undefined;
    }

    const id = `installation-option-registration-${Date.now()}-${++this.sequence}`;
    const attempt: InstallationOptionRegistrationAttempt = {
      id,
      group: input.group,
      name: input.name,
      draftName: input.draftName,
      targets: [input.target],
      state: 'registering',
    };
    this.publish([...this.attempts, attempt]);
    const operation = (async (): Promise<InstallationCodeOption | undefined> => {
      try {
        const option = await input.create();
        this.publish(this.attempts.filter((item) => item.id !== id));
        return option;
      } catch (error) {
        if (input.isDefiniteFailure(error)) {
          this.publish(this.attempts.filter((item) => item.id !== id));
          throw error;
        }
        this.update(id, {
          state: 'uncertain',
          message:
            '등록 응답을 확인하지 못했습니다. 같은 요청을 다시 보내지 않고 목록에서 등록 여부를 확인해 주세요.',
        });
        return undefined;
      }
    })();
    this.inFlight.set(id, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(id);
    }
  }

  setDraftName(id: string, draftName: string) {
    const attempt = this.attempts.find((item) => item.id === id);
    if (attempt) this.update(id, { draftName });
  }

  async confirm(
    id: string,
    reload: () => Promise<readonly InstallationCodeOption[]>,
    onLoaded: (options: readonly InstallationCodeOption[]) => void,
  ) {
    const attempt = this.attempts.find((item) => item.id === id);
    if (
      !attempt ||
      attempt.state === 'registering' ||
      attempt.state === 'checking' ||
      attempt.state === 'retrying'
    )
      return;
    this.update(id, { state: 'checking', message: undefined });
    try {
      const options = await reload();
      onLoaded(options);
      const found = options.find(
        (option) =>
          option.group === attempt.group &&
          installationOptionNameKey(option.name) === installationOptionNameKey(attempt.name),
      );
      this.update(
        id,
        found
          ? {
              state: 'found',
              option: found,
              message: '등록된 선택지를 찾았습니다. 필드 값이 그대로일 때만 연결할 수 있습니다.',
            }
          : {
              state: 'absent',
              option: undefined,
              message: '현재 목록에서 찾지 못했습니다. 확인된 뒤에만 등록 재시도를 할 수 있습니다.',
            },
      );
    } catch {
      this.update(id, {
        state: 'uncertain',
        message:
          '목록 확인에 실패했습니다. 입력한 이름을 보존했습니다. 확인이 성공할 때까지 등록 재시도는 잠겨 있습니다.',
      });
    }
  }

  async retry(
    id: string,
    create: (group: InstallationCodeGroup, name: string) => Promise<InstallationCodeOption>,
    isDefiniteFailure: (error: unknown) => boolean,
    onCreated: (option: InstallationCodeOption) => void,
  ) {
    const attempt = this.attempts.find((item) => item.id === id);
    if (!attempt || attempt.state !== 'absent') return;
    this.update(id, { state: 'retrying', message: undefined });
    try {
      const option = await create(attempt.group, attempt.name);
      onCreated(option);
      this.update(id, {
        state: 'found',
        option,
        message: '재등록을 완료했습니다. 필드 값이 그대로일 때만 연결할 수 있습니다.',
      });
    } catch (error) {
      this.update(id, {
        state: isDefiniteFailure(error) ? 'absent' : 'uncertain',
        message: isDefiniteFailure(error)
          ? '재등록이 거부되었습니다. 목록을 다시 확인한 뒤 필요한 경우에만 재시도해 주세요.'
          : '재등록 응답을 확인하지 못했습니다. 같은 요청을 다시 보내지 않고 목록에서 결과를 확인해 주세요.',
      });
    }
  }

  dismissTarget(id: string, target: InstallationOptionRegistrationTarget) {
    const attempt = this.attempts.find((item) => item.id === id);
    if (!attempt) return;
    const key = installationOptionTargetKey(target);
    const targets = attempt.targets.filter((item) => installationOptionTargetKey(item) !== key);
    if (targets.length) this.update(id, { targets });
    else this.publish(this.attempts.filter((item) => item.id !== id));
  }

  dismiss(id: string) {
    const attempt = this.attempts.find((item) => item.id === id);
    if (!attempt || ['registering', 'checking', 'retrying'].includes(attempt.state)) return;
    this.publish(this.attempts.filter((item) => item.id !== id));
  }
}

export function parseInstallationCodeOptions(value: unknown): InstallationCodeOption[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length > 10_000) return undefined;
  const allowedGroups = new Set<string>(installationCodeGroups);
  const result: InstallationCodeOption[] = [];
  for (const item of items) {
    // Catalog rows are independently validated. A legacy row must not disable
    // every option in this response merely because one row is malformed.
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.group !== 'string' || !allowedGroups.has(row.group)) continue;
    const name = normalizeInstallationOptionName(row.name);
    // Legacy catalog codes follow catalog.ts's text contract, not the generated install-* format.
    if (
      typeof row.id !== 'string' ||
      !row.id.trim() ||
      row.id.length > 200 ||
      !Number.isSafeInteger(row.revision) ||
      (row.revision as number) < 0 ||
      typeof row.active !== 'boolean' ||
      typeof row.code !== 'string' ||
      !row.code.trim() ||
      row.code.length > 100 ||
      row.code.includes('\0') ||
      !name ||
      typeof row.groupName !== 'string' ||
      row.groupName.length > 200 ||
      typeof row.parentCode !== 'string' ||
      row.parentCode.length > 100 ||
      row.parentCode.includes('\0') ||
      (row.numericValue !== null && !Number.isSafeInteger(row.numericValue))
    )
      continue;
    if (!row.active) continue;
    result.push({
      id: row.id,
      revision: Number(row.revision),
      active: true,
      group: row.group as InstallationCodeGroup,
      groupName: installationCodeGroupName(row.group as InstallationCodeGroup),
      code: row.code,
      name,
      parentCode: row.parentCode,
      numericValue: row.numericValue as number | null,
    });
  }
  return result;
}

export function installationOptionForFieldValue(
  options: readonly InstallationCodeOption[],
  group: InstallationCodeGroup,
  value: string,
): InstallationCodeOption | undefined {
  const exactCode = options.filter((option) => option.group === group && option.code === value);
  if (exactCode.length === 1) return exactCode[0];
  const exactName = options.filter((option) => option.group === group && option.name === value);
  return exactName.length === 1 ? exactName[0] : undefined;
}

export function installationOptionDisplayValue(
  options: readonly InstallationCodeOption[],
  group: InstallationCodeGroup | undefined,
  value: string,
  optionValue?: string,
) {
  if (!group) return value;
  return installationOptionForFieldValue(options, group, optionValue ?? value)?.name ?? value;
}
