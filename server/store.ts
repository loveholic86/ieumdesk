import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { archiveAreaLabels, type ArchiveArea, type ArchivedEntry } from '../src/archive-types.ts';
import { randomUUID } from 'node:crypto';
import type { Company, CompanyList, Activity, Task, CRMRecord, RecordKind } from '../src/types.ts';
import type { CompanyInput, ActivityInput, TaskInput, ListQuery, RecordInput } from './validation.ts';
import { createSeed, createRecordSeed, type DataSet } from './seed.ts';
import { assembleRecord, assertQuotationPermission, quotationRevision, taskState } from './records.ts';
import { ApiError, notFound } from './errors.ts';
import { businessDate, businessDateAfter } from './dates.ts';
import {
  installationMetadataConflict,
  installationMetadataRecordPatch,
  installationMetadataRevision,
} from './installation-metadata.ts';
import { openLegacyVault, type LegacyVault } from './legacy-vault.ts';
export { ApiError, notFound } from './errors.ts';

export function validateContract(company: Pick<Company, 'contractStart' | 'contractEnd'>) {
  if (company.contractStart && company.contractEnd && company.contractStart > company.contractEnd) {
    throw new ApiError(400, 'INVALID_CONTRACT_DATES', '계약 종료일은 시작일 이후여야 합니다.');
  }
}
export interface Store {
  mode: 'demo' | 'postgres';
  listArchived(): Promise<ArchivedEntry[]>;
  archive(area: ArchiveArea, id: string, actorId: string): Promise<{ success: true }>;
  restoreArchived(area: ArchiveArea, id: string, actorId: string): Promise<{ success: true }>;
  health(): Promise<void>;
  listCompanies(query: ListQuery): Promise<CompanyList>;
  getCompany(id: string): Promise<Company>;
  createCompany(input: CompanyInput): Promise<Company>;
  updateCompany(id: string, patch: Partial<CompanyInput>): Promise<Company>;
  listAllActivities(): Promise<Activity[]>;
  listActivities(companyId: string): Promise<Activity[]>;
  createActivity(companyId: string, input: ActivityInput): Promise<Activity>;
  updateActivity(id: string, patch: import('./validation.ts').ActivityPatch): Promise<Activity>;
  listTasks(): Promise<Task[]>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, patch: Partial<TaskInput>): Promise<Task>;
  listRecords(kind: RecordKind): Promise<CRMRecord[]>;
  createQuotationRevision(id: string, input: RecordInput): Promise<CRMRecord>;
  createRecord(
    kind: RecordKind,
    input: RecordInput,
    actor?: { name: string; role: string },
  ): Promise<CRMRecord>;
  updateRecord(
    kind: RecordKind,
    id: string,
    patch: Partial<RecordInput>,
    actor?: { name: string; role: string },
  ): Promise<CRMRecord>;
  updateInstallationMetadata(
    id: string,
    patch: Partial<RecordInput>,
    expectedRevision: string,
    actor: { id: string; name: string; role: string },
  ): Promise<CRMRecord>;
  close?(): Promise<void>;
}

export function renewalWindow(now = new Date()) {
  return { today: businessDate(now), until: businessDateAfter(30, now) };
}

export function selectCompanies(companies: Company[], query: ListQuery): CompanyList {
  companies = companies.filter((company) => !company.archivedAt);
  const { today, until } = renewalWindow();
  const term = query.q.toLocaleLowerCase();
  const filtered = companies
    .filter(
      (company) =>
        (!term ||
          [
            company.companyCode || '',
            company.name,
            company.businessNumber,
            company.contactName,
            company.email,
            company.phone,
          ].some((value) => value.toLocaleLowerCase().includes(term))) &&
        (!query.status || query.status === 'all' || company.status === query.status) &&
        (!query.product || query.product === 'all' || company.products.includes(query.product)) &&
        (!query.owner || query.owner === 'all' || company.owner === query.owner) &&
        (!query.serviceVersion ||
          query.serviceVersion === 'all' ||
          company.serviceVersion === query.serviceVersion),
    )
    .sort((a, b) => {
      if (query.sort === 'contractEnd' && Boolean(a.contractEnd) !== Boolean(b.contractEnd))
        return a.contractEnd ? -1 : 1;
      const comparison = a[query.sort].localeCompare(b[query.sort], 'ko') || a.id.localeCompare(b.id);
      return query.order === 'asc' ? comparison : -comparison;
    });
  const offset = (query.page - 1) * query.pageSize;
  return {
    items: filtered.slice(offset, offset + query.pageSize),
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    mode: 'demo',
    stats: {
      total: companies.length,
      active: companies.filter((company) => company.status === 'active').length,
      prospect: companies.filter((company) => company.status === 'prospect').length,
      renewalDue: companies.filter(
        (company) =>
          company.status === 'active' && company.contractEnd >= today && company.contractEnd <= until,
      ).length,
    },
  };
}

const demoQueues = new Map<string, Promise<unknown>>();
const demoContext = {
  source: 'yeta-crm-demo',
  table: 'business_data',
  primaryKey: 'local',
  batchId: 'storage-v2',
};
const demoUnavailable = () =>
  new ApiError(503, 'DEMO_STORAGE_UNAVAILABLE', '데모 암호화 저장소를 확인하지 못했습니다.');
const missingFile = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class DemoStore implements Store {
  readonly mode = 'demo' as const;
  private queue: Promise<unknown> = Promise.resolve();
  private vault?: Promise<LegacyVault>;
  constructor(
    private file = path.resolve('.local/crm-demo.json'),
    private options: { keyFile?: string } = {},
  ) {
    this.file = path.resolve(file);
  }
  get storageFile() {
    return path.resolve(this.file);
  }
  async health() {
    await this.read();
  }
  private openVault(createIfMissing = false) {
    return (this.vault ??= openLegacyVault({
      keyFile: this.options.keyFile ?? path.join(path.dirname(this.file), '.keys', 'crm-data.key'),
      createIfMissing,
    }));
  }
  private async directory() {
    const directory = path.dirname(this.file);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw demoUnavailable();
    }
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o7777) !== 0o700
    )
      throw demoUnavailable();
  }
  private async validateFile(file: FileHandle) {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o7777) !== 0o600
    )
      throw demoUnavailable();
  }
  private normalize(data: DataSet): DataSet {
    if (
      data.version !== 1 ||
      !Array.isArray(data.companies) ||
      !Array.isArray(data.activities) ||
      !Array.isArray(data.tasks)
    )
      throw demoUnavailable();
    data.companies = data.companies.map((company) => ({
      companyCode: '',
      corporationNumber: '',
      companyType: '',
      groupName: '',
      firstContactDate: '',
      contactSource: '',
      contactDetail: '',
      serviceVersion: '',
      ...company,
    }));
    data.tasks = data.tasks.map((task) => ({ ...task, ...taskState({}, task) }));
    data.records ??= createRecordSeed(data.companies);
    if (
      Object.values(data.records).some((records) => !Array.isArray(records)) ||
      ['contacts', 'sales', 'quotations', 'installations'].some((kind) => !(kind in data.records!))
    )
      throw demoUnavailable();
    return data;
  }
  private async load(): Promise<{ data: DataSet; upgrade: boolean; missing: boolean }> {
    await this.directory();
    let file: FileHandle;
    try {
      file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missingFile(error)) return { data: createSeed(), upgrade: true, missing: true };
      throw demoUnavailable();
    }
    try {
      await this.validateFile(file);
      const stored = JSON.parse(await file.readFile('utf8'));
      await this.validateFile(file);
      if (stored?.version === 2 && stored.document) {
        const data = JSON.parse((await this.openVault()).decrypt(stored.document, demoContext));
        return { data: this.normalize(data), upgrade: false, missing: false };
      }
      return { data: this.normalize(stored), upgrade: true, missing: false };
    } catch (error) {
      throw demoUnavailable();
    } finally {
      await file.close();
    }
  }
  /** The replacement and its directory entry are durable before reporting success. */
  private async persist(data: DataSet, createOnly: boolean): Promise<boolean> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    let ownedTemporary = false;
    try {
      const document = (await this.openVault()).encrypt(JSON.stringify(data), demoContext);
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      ownedTemporary = true;
      await handle.writeFile(JSON.stringify({ version: 2, document }));
      await handle.sync();
      await this.validateFile(handle);
      await handle.close();
      handle = undefined;
      await this.directory();
      if (createOnly) {
        // Atomic no-clobber installation of an already complete encrypted file.
        try {
          await link(temporary, this.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        await unlink(temporary);
      } else {
        const current = await open(
          this.file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          await this.validateFile(current);
        } finally {
          await current.close();
        }
        await rename(temporary, this.file);
      }
      const directory = await open(
        path.dirname(this.file),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return true;
    } catch {
      throw demoUnavailable();
    } finally {
      await handle?.close();
      if (ownedTemporary)
        await unlink(temporary).catch((error) => {
          if (!missingFile(error)) throw demoUnavailable();
        });
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = (demoQueues.get(this.file) ?? Promise.resolve()).then(operation);
    this.queue = result.catch(() => undefined);
    demoQueues.set(this.file, this.queue);
    const settled = this.queue;
    void settled.then(() => {
      if (demoQueues.get(this.file) === settled) demoQueues.delete(this.file);
    });
    return result;
  }
  private async read(): Promise<DataSet> {
    return this.enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await this.load();
        if (!loaded.upgrade) return loaded.data;
        await this.openVault(true);
        if (await this.persist(loaded.data, loaded.missing)) return loaded.data;
      }
      throw demoUnavailable();
    });
  }
  private async mutate<T>(operation: (data: DataSet) => T): Promise<T> {
    return this.enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await this.load();
        const value = operation(loaded.data);
        await this.openVault(loaded.upgrade);
        if (await this.persist(loaded.data, loaded.missing)) return value;
      }
      throw demoUnavailable();
    });
  }
  async close() {
    await this.queue;
  }
  async listArchived(): Promise<ArchivedEntry[]> {
    const data = await this.read();
    const items: ArchivedEntry[] = [];
    const add = (area: ArchiveArea, rows: (Company | Activity | Task | CRMRecord)[]) => {
      for (const row of rows)
        if (row.archivedAt)
          items.push({
            area,
            id: row.id,
            title:
              'name' in row
                ? row.name
                : 'number' in row
                  ? row.number
                  : 'systemCode' in row
                    ? row.systemCode
                    : row.title || row.id,
            archivedAt: row.archivedAt,
            archivedBy: row.archivedBy || '',
          });
    };
    add('companies', data.companies);
    add('activities', data.activities);
    add('tasks', data.tasks);
    for (const kind of ['contacts', 'sales', 'quotations', 'installations'] as const)
      add(kind, data.records![kind]);
    return items.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }
  async archive(area: ArchiveArea, id: string, actorId: string): Promise<{ success: true }> {
    return this.mutate((data) => {
      const rows =
        area === 'companies'
          ? data.companies
          : area === 'activities'
            ? data.activities
            : area === 'tasks'
              ? data.tasks
              : data.records![area];
      const row = rows.find((row) => row.id === id && !row.archivedAt);
      if (!row) throw notFound();
      if (area === 'companies') {
        const counts: Partial<Record<ArchiveArea, number>> = {};
        counts.activities = data.activities.filter(
          (item) => !item.archivedAt && item.companyId === id,
        ).length;
        counts.tasks = data.tasks.filter((item) => !item.archivedAt && item.companyId === id).length;
        for (const kind of ['contacts', 'sales', 'quotations', 'installations'] as const)
          counts[kind] = data.records![kind].filter(
            (item) => !item.archivedAt && (item.companyId === id || item.relatedCompanyIds?.includes(id)),
          ).length;
        const linked = Object.entries(counts)
          .filter(([, count]) => count! > 0)
          .map(([kind, count]) => `${archiveAreaLabels[kind as ArchiveArea]} ${count}건`)
          .join(', ');
        if (linked)
          throw new ApiError(
            409,
            'COMPANY_HAS_ACTIVE_LINKS',
            `연결된 자료가 있습니다 (${linked}). 해당 자료를 먼저 휴지통으로 이동하거나 고객사 연결을 변경해 주세요.`,
          );
      }
      row.archivedAt = new Date().toISOString();
      row.archivedBy = actorId;
      return { success: true };
    });
  }
  async restoreArchived(area: ArchiveArea, id: string, _actorId: string): Promise<{ success: true }> {
    return this.mutate((data) => {
      const rows =
        area === 'companies'
          ? data.companies
          : area === 'activities'
            ? data.activities
            : area === 'tasks'
              ? data.tasks
              : data.records![area];
      const row = rows.find((row) => row.id === id && row.archivedAt);
      if (!row) throw notFound();
      if (area !== 'companies') {
        const linked = [
          ...new Set(
            [
              'companyId' in row ? row.companyId : '',
              ...('relatedCompanyIds' in row ? row.relatedCompanyIds || [] : []),
            ].filter(Boolean),
          ),
        ];
        if (linked.some((id) => !data.companies.some((company) => company.id === id && !company.archivedAt)))
          throw new ApiError(409, 'ARCHIVED_COMPANY_REFERENCE', '연결된 고객사를 먼저 복원해 주세요.');
      }
      delete row.archivedAt;
      delete row.archivedBy;
      return { success: true };
    });
  }
  async listCompanies(query: ListQuery) {
    return selectCompanies((await this.read()).companies, query);
  }
  async getCompany(id: string) {
    const company = (await this.read()).companies.find((item) => item.id === id && !item.archivedAt);
    if (!company) throw notFound();
    return company;
  }
  async createCompany(input: CompanyInput) {
    validateContract(input);
    return this.mutate((data) => {
      const company: Company = { ...input, id: randomUUID(), updatedAt: new Date().toISOString() };
      data.companies.unshift(company);
      return company;
    });
  }
  async updateCompany(id: string, patch: Partial<CompanyInput>) {
    return this.mutate((data) => {
      const index = data.companies.findIndex((item) => item.id === id && !item.archivedAt);
      if (index < 0) throw notFound();
      const company = { ...data.companies[index], ...patch, updatedAt: new Date().toISOString() };
      validateContract(company);
      data.companies[index] = company;
      return company;
    });
  }
  async listAllActivities() {
    return (await this.read()).activities
      .filter((item) => !item.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async listActivities(companyId: string) {
    await this.getCompany(companyId);
    return (await this.read()).activities
      .filter((item) => item.companyId === companyId && !item.archivedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createActivity(companyId: string, input: ActivityInput) {
    return this.mutate((data) => {
      const company = data.companies.find((item) => item.id === companyId && !item.archivedAt);
      if (!company) throw notFound();
      const activity: Activity = {
        ...input,
        id: randomUUID(),
        companyId,
        createdAt: new Date().toISOString(),
      };
      data.activities.unshift(activity);
      company.updatedAt = activity.createdAt;
      return activity;
    });
  }
  async updateActivity(id: string, patch: import('./validation.ts').ActivityPatch) {
    return this.mutate((data) => {
      const index = data.activities.findIndex((item) => item.id === id && !item.archivedAt);
      if (index < 0) throw notFound();
      const activity = { ...data.activities[index], ...patch };
      data.activities[index] = activity;
      return activity;
    });
  }
  async listTasks() {
    return (await this.read()).tasks
      .filter((item) => !item.archivedAt)
      .sort(
        (a, b) =>
          Number(a.completed) - Number(b.completed) ||
          Number(!a.dueDate) - Number(!b.dueDate) ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.id.localeCompare(b.id),
      );
  }
  async createTask(input: TaskInput) {
    return this.mutate((data) => {
      if (input.companyId && !data.companies.some((item) => item.id === input.companyId && !item.archivedAt))
        throw notFound();
      if (
        input.contactId &&
        !data.records!.contacts.some(
          (contact) =>
            contact.id === input.contactId && !contact.archivedAt && contact.companyId === input.companyId,
        )
      )
        throw new ApiError(400, 'INVALID_TASK_CONTACT', '선택한 고객사에 연결된 담당자를 선택해 주세요.');
      if (input.startDate && input.dueDate && input.startDate > input.dueDate)
        throw new ApiError(400, 'INVALID_TASK_DATES', '요청기한은 시작일보다 빠를 수 없습니다.');
      const task: Task = { ...input, ...taskState(input), id: randomUUID() };
      data.tasks.push(task);
      return task;
    });
  }
  async updateTask(id: string, patch: Partial<TaskInput>) {
    return this.mutate((data) => {
      const index = data.tasks.findIndex((item) => item.id === id && !item.archivedAt);
      if (index < 0) throw notFound();
      if (patch.companyId && !data.companies.some((item) => item.id === patch.companyId && !item.archivedAt))
        throw notFound();
      const reset =
        patch.companyId !== undefined && patch.companyId !== data.tasks[index].companyId
          ? { contactId: '', contactName: '' }
          : {};
      const task = { ...data.tasks[index], ...reset, ...patch, ...taskState(patch, data.tasks[index]) };
      if (
        ('contactId' in patch || 'companyId' in patch) &&
        task.contactId &&
        !data.records!.contacts.some(
          (contact) =>
            contact.id === task.contactId && !contact.archivedAt && contact.companyId === task.companyId,
        )
      )
        throw new ApiError(400, 'INVALID_TASK_CONTACT', '선택한 고객사에 연결된 담당자를 선택해 주세요.');
      if (
        ('startDate' in patch || 'dueDate' in patch) &&
        task.startDate &&
        task.dueDate &&
        task.startDate > task.dueDate
      )
        throw new ApiError(400, 'INVALID_TASK_DATES', '요청기한은 시작일보다 빠를 수 없습니다.');
      data.tasks[index] = task;
      return task;
    });
  }
  async listRecords(kind: RecordKind) {
    const data = await this.read();
    return [...data.records![kind]]
      .filter((record) => !record.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  async createRecord(kind: RecordKind, input: RecordInput, actor?: { name: string; role: string }) {
    return this.mutate((data) => {
      if (!data.companies.some((company) => company.id === input.companyId && !company.archivedAt))
        throw notFound();
      for (const relatedId of ('relatedCompanyIds' in input ? input.relatedCompanyIds : []) || [])
        if (!data.companies.some((company) => company.id === relatedId && !company.archivedAt))
          throw notFound();
      if (kind === 'quotations' && actor)
        assertQuotationPermission(actor.role, input as Partial<import('../src/types.ts').QuotationRecord>);
      const record = assembleRecord(kind, input, randomUUID(), undefined, actor?.name);
      (data.records![kind] as CRMRecord[]).unshift(record);
      return record;
    });
  }
  async createQuotationRevision(id: string, input: RecordInput) {
    return this.mutate((data) => {
      const source = data.records!.quotations.find((record) => record.id === id && !record.archivedAt);
      if (!source) throw notFound();
      if (!data.companies.some((company) => company.id === input.companyId && !company.archivedAt))
        throw notFound();
      const record = quotationRevision(source, assembleRecord('quotations', input, randomUUID()));
      data.records!.quotations.unshift(record);
      return record;
    });
  }
  async updateRecord(
    kind: RecordKind,
    id: string,
    patch: Partial<RecordInput>,
    actor?: { name: string; role: string },
  ) {
    return this.mutate((data) => {
      const records = data.records![kind] as CRMRecord[];
      const index = records.findIndex((record) => record.id === id && !record.archivedAt);
      if (index < 0) throw notFound();
      if (
        patch.companyId &&
        !data.companies.some((company) => company.id === patch.companyId && !company.archivedAt)
      )
        throw notFound();
      for (const relatedId of ('relatedCompanyIds' in patch ? patch.relatedCompanyIds : []) || [])
        if (!data.companies.some((company) => company.id === relatedId && !company.archivedAt))
          throw notFound();
      if (kind === 'quotations' && actor)
        assertQuotationPermission(
          actor.role,
          patch as Partial<import('../src/types.ts').QuotationRecord>,
          records[index] as import('../src/types.ts').QuotationRecord,
        );
      const record = assembleRecord(kind, patch, id, records[index], actor?.name);
      records[index] = record;
      return record;
    });
  }
  async updateInstallationMetadata(
    id: string,
    patch: Partial<RecordInput>,
    expectedRevision: string,
    actor: { id: string; name: string; role: string },
  ): Promise<CRMRecord> {
    const validated = installationMetadataRecordPatch(patch);
    return this.mutate((data) => {
      if (actor.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      const records = data.records!.installations;
      const index = records.findIndex((record) => record.id === id && !record.archivedAt);
      if (index < 0) throw notFound();
      if (installationMetadataRevision(records[index]) !== expectedRevision)
        throw installationMetadataConflict();
      const record = assembleRecord('installations', validated, id, records[index], actor.name);
      records[index] = record as import('../src/types.ts').InstallationRecord;
      return record;
    });
  }
}
