import pg from 'pg';
import { archiveAreaLabels, type ArchiveArea, type ArchivedEntry } from '../src/archive-types.ts';
import { randomUUID } from 'node:crypto';
import type { Company, CompanyList, Activity, Task, CRMRecord, RecordKind } from '../src/types.ts';
import type { CompanyInput, ActivityInput, TaskInput, ListQuery, RecordInput } from './validation.ts';
import { ApiError, notFound, selectCompanies, validateContract, type Store } from './store.ts';
import { databaseConfig } from './config.ts';
import { assembleRecord, assertQuotationPermission, quotationRevision, taskState } from './records.ts';
import { BusinessLegacyReader } from './business-legacy.ts';
import { BusinessEncryption, businessPrivateColumns, storageUnavailable, type ScalarBusinessTable } from './business-encryption.ts';
import type { LegacyVault } from './legacy-vault.ts';
import {
  installationMetadataConflict,
  installationMetadataRecordPatch,
  installationMetadataRevision,
} from './installation-metadata.ts';

const companyColumns = {
  name: 'name',
  businessNumber: 'business_number',
  industry: 'industry',
  ceo: 'ceo',
  contactName: 'contact_name',
  contactRole: 'contact_role',
  email: 'email',
  phone: 'phone',
  owner: 'owner',
  status: 'status',
  products: 'products',
  employees: 'employees',
  contractStart: 'contract_start',
  contractEnd: 'contract_end',
  contractAmount: 'contract_amount',
  website: 'website',
  address: 'address',
  zipcode: 'zipcode',
  note: 'note',
  companyCode: 'company_code',
  corporationNumber: 'corporation_number',
  companyType: 'company_type',
  groupName: 'group_name',
  firstContactDate: 'first_contact_date',
  contactSource: 'contact_source',
  contactDetail: 'contact_detail',
  serviceVersion: 'service_version',
} as const;
const companyKeys = Object.keys(companyColumns) as (keyof CompanyInput)[];
const companySelect = `id, ${companyKeys
  .map((key) => {
    if (key === 'contractStart' || key === 'contractEnd' || key === 'firstContactDate')
      return `COALESCE(${companyColumns[key]}::text, '') AS "${key}"`;
    if (key === 'contractAmount') return `contract_amount::float8 AS "contractAmount"`;
    return `${companyColumns[key]} AS "${key}"`;
  })
  .join(', ')}, protected_data AS "_protectedData", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;
const activitySelect = `id, company_id AS "companyId", type, title, body, author, activity_date_edited AS "_activityDateEdited", (CASE WHEN activity_date_edited THEN COALESCE(activity_date::text, '') ELSE activity_date::text END) AS "activityDate", activity_type_edited AS "_activityTypeEdited", protected_data AS "_protectedData", to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;
const taskSelect = `id, title, COALESCE(company_id, '') AS "companyId", COALESCE(due_date::text, '') AS "dueDate", completed, priority, status, type, owner, body, start_date_edited AS "_startDateEdited", (CASE WHEN start_date_edited THEN COALESCE(start_date::text, '') ELSE start_date::text END) AS "startDate", contact_id AS "contactId", contact_name AS "contactName", protected_data AS "_protectedData"`;
const companyValue = (key: keyof CompanyInput, value: unknown) =>
  (key === 'contractStart' || key === 'contractEnd' || key === 'firstContactDate') && !value ? null : value;
type RecordRow = { id: string; kind: RecordKind; companyId: string | null; data: Record<string, unknown>; updatedAt: string; _protectedData: unknown };
const recordSelect = `id, kind, company_id AS "companyId", data, protected_data AS "_protectedData", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;
const activityColumns = { title: 'title', body: 'body', author: 'author', activityDate: 'activity_date' };
const taskPrivateColumns = { title: 'title', owner: 'owner', body: 'body', startDate: 'start_date', dueDate: 'due_date', contactName: 'contact_name' };

const withoutNullExtensions = <T extends object>(row: T): T =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key, value]) => value !== null || !['zipcode', 'startDate', 'contactId', 'contactName'].includes(key),
    ),
  ) as T;

export class PostgresStore implements Store {
  readonly mode = 'postgres' as const;
  private legacy: BusinessLegacyReader;
  private encryption: BusinessEncryption;
  constructor(private pool: pg.Pool, vault?: () => Promise<LegacyVault>) {
    this.legacy = new BusinessLegacyReader(pool);
    this.encryption = new BusinessEncryption(vault);
  }
  private async decodeProjection<T extends { id: string }>(table: ScalarBusinessTable, row: T): Promise<T> {
    const source = row as T & Record<string, unknown>;
    const decoded = await this.encryption.decrypt(table, { id: source.id, protected_data: source._protectedData });
    const { _protectedData, _activityDateEdited, _startDateEdited, ...rest } = source;
    const result: Record<string, unknown> = { ...rest };
    const columns = table === 'companies' ? companyColumns : table === 'activities' ? activityColumns : taskPrivateColumns;
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(businessPrivateColumns[table], column)) continue;
      let value = decoded[column];
      if (['contractStart', 'contractEnd', 'firstContactDate', 'dueDate'].includes(key) && value === null) value = '';
      if (key === 'activityDate' && value === null && _activityDateEdited) value = '';
      if (key === 'startDate' && value === null && _startDateEdited) value = '';
      result[key] = value;
    }
    return result as T;
  }
  private async encodeProjection(table: ScalarBusinessTable, id: string, values: Record<string, unknown>) {
    const columns = table === 'companies' ? companyColumns : table === 'activities' ? activityColumns : taskPrivateColumns;
    const raw: Record<string, unknown> = { id };
    for (const [key, column] of Object.entries(columns)) {
      let value = values[key];
      if (['contractStart', 'contractEnd', 'firstContactDate', 'dueDate', 'startDate', 'activityDate'].includes(key) && !value) value = null;
      raw[column] = value ?? null;
    }
    return this.encryption.encrypt(table, raw);
  }
  private async fromRecordRow(row: RecordRow): Promise<CRMRecord> {
    const decoded = await this.encryption.decrypt('records', { id: row.id, kind: row.kind, data: row.data, protected_data: row._protectedData });
    return { ...(decoded.data as Record<string, unknown>), id: row.id, companyId: row.companyId, updatedAt: row.updatedAt } as unknown as CRMRecord;
  }
  static async connect() {
    const pool = new pg.Pool(await databaseConfig());
    // Pool error events must not crash the process or expose connection details.
    pool.on('error', () => console.error('DATABASE_POOL_ERROR'));
    const store = new PostgresStore(pool);
    try {
      await store.health();
    } catch (error) {
      await pool.end();
      throw error;
    }
    return store;
  }
  async listArchived(): Promise<ArchivedEntry[]> {
    const suffix = `archived_at::text AS "archivedAt", COALESCE(archived_by,'') AS "archivedBy"`;
    const scalar = await Promise.all((['companies', 'activities', 'tasks'] as const).map(async table => {
      const selection = table === 'companies' ? companySelect : table === 'activities' ? activitySelect : taskSelect;
      const result = await this.pool.query(`SELECT ${selection}, ${suffix} FROM yeta_crm.${table} WHERE archived_at IS NOT NULL`);
      return Promise.all(result.rows.map(async row => {
        const decoded = await this.decodeProjection(table, row);
        return { area: table, id: row.id, title: String(table === 'companies' ? decoded.name : decoded.title), archivedAt: row.archivedAt, archivedBy: row.archivedBy } as ArchivedEntry;
      }));
    }));
    const records = await this.pool.query<RecordRow & { archivedAt: string; archivedBy: string }>(`SELECT ${recordSelect}, ${suffix} FROM yeta_crm.records WHERE archived_at IS NOT NULL`);
    const mapped = await Promise.all(records.rows.map(async row => {
      const data = await this.fromRecordRow(row) as unknown as Record<string, unknown>;
      return { area: row.kind, id: row.id, title: String(data.name ?? data.number ?? data.systemCode ?? row.id), archivedAt: row.archivedAt, archivedBy: row.archivedBy } as ArchivedEntry;
    }));
    return [...scalar.flat(), ...mapped].sort((a,b) => b.archivedAt.localeCompare(a.archivedAt));
  }
  private async archiveChange(
    area: ArchiveArea,
    id: string,
    actorId: string,
    restore: boolean,
  ): Promise<{ success: true }> {
    const table = ['companies', 'activities', 'tasks'].includes(area) ? area : 'records';
    const recordKind = table === 'records' ? area : undefined;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const values = recordKind ? [id, recordKind] : [id];
      const found = await client.query(
        `SELECT * FROM yeta_crm.${table} WHERE id=$1 ${recordKind ? 'AND kind=$2' : ''} AND archived_at IS ${restore ? 'NOT ' : ''}NULL FOR UPDATE`,
        values,
      );
      if (!found.rows[0]) throw notFound();
      if (!restore && area === 'companies') {
        // Serialize with the support table's active-company trigger under this customer lock.
        const hasSupportTable = (
          await client.query("SELECT to_regclass('yeta_crm_private.support_items') IS NOT NULL AS ready")
        ).rows[0].ready;
        if (
          hasSupportTable &&
          (
            await client.query(
              'SELECT 1 FROM yeta_crm_private.support_items WHERE company_id=$1 AND archived_at IS NULL LIMIT 1',
              [id],
            )
          ).rowCount
        )
          throw new ApiError(
            409,
            'COMPANY_HAS_SUPPORT',
            '연결된 고객지원 자료를 먼저 휴지통으로 이동해 주세요.',
          );
        const counts = (
          await client.query<{ area: ArchiveArea; count: number }>(
            `SELECT 'activities' AS area,count(*)::int AS count FROM yeta_crm.activities WHERE company_id=$1 AND archived_at IS NULL
          UNION ALL SELECT 'tasks',count(*)::int FROM yeta_crm.tasks WHERE company_id=$1 AND archived_at IS NULL
          UNION ALL SELECT kind,count(*)::int FROM yeta_crm.records WHERE archived_at IS NULL AND (company_id=$1 OR COALESCE(data->'relatedCompanyIds','[]'::jsonb) @> jsonb_build_array($1::text)) GROUP BY kind`,
            [id],
          )
        ).rows;
        const linked = counts
          .filter((row) => row.count > 0)
          .map((row) => `${archiveAreaLabels[row.area]} ${row.count}건`)
          .join(', ');
        if (linked)
          throw new ApiError(
            409,
            'COMPANY_HAS_ACTIVE_LINKS',
            `연결된 자료가 있습니다 (${linked}). 해당 자료를 먼저 휴지통으로 이동하거나 고객사 연결을 변경해 주세요.`,
          );
      }
      if (restore && area !== 'companies') {
        const row = found.rows[0];
        const linked = [
          ...new Set(
            [
              row.company_id,
              ...(Array.isArray(row.data?.relatedCompanyIds) ? row.data.relatedCompanyIds : []),
            ].filter((id): id is string => typeof id === 'string' && id.length > 0),
          ),
        ];
        const active = (
          await client.query(
            'SELECT id FROM yeta_crm.companies WHERE id=ANY($1::text[]) AND archived_at IS NULL ORDER BY id FOR KEY SHARE',
            [linked],
          )
        ).rows;
        if (active.length !== linked.length)
          throw new ApiError(409, 'ARCHIVED_COMPANY_REFERENCE', '연결된 고객사를 먼저 복원해 주세요.');
      }
      const actor = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actorId])
      ).rows[0];
      if (actor?.role !== 'admin' || actor?.status !== 'active')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      await client.query(
        `UPDATE yeta_crm.${table} SET archived_at=${restore ? 'NULL' : 'now()'},archived_by=${restore ? 'NULL' : `$${values.length + 1}`} WHERE id=$1 ${recordKind ? 'AND kind=$2' : ''}`,
        restore ? values : [...values, actorId],
      );
      await client.query(
        "INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result,fields) VALUES($1,$2,$3,'완료',$4::jsonb)",
        [
          actorId,
          restore ? '휴지통 복원' : '휴지통 이동',
          area,
          JSON.stringify(['archived_at', 'archived_by']),
        ],
      );
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async archive(area: ArchiveArea, id: string, actorId: string) {
    return this.archiveChange(area, id, actorId, false);
  }
  async restoreArchived(area: ArchiveArea, id: string, actorId: string) {
    return this.archiveChange(area, id, actorId, true);
  }
  async health() {
    const result = await this.pool.query(`SELECT to_regclass('yeta_crm.companies') IS NOT NULL
      AND to_regclass('yeta_crm.activities') IS NOT NULL AND to_regclass('yeta_crm.tasks') IS NOT NULL
      AND to_regclass('yeta_crm.records') IS NOT NULL AS ready`);
    if (!result.rows[0]?.ready)
      throw new ApiError(
        503,
        'DATABASE_SCHEMA_MISSING',
        'CRM 전용 스키마가 준비되지 않았습니다. 데이터베이스 초기화 절차를 확인해 주세요.',
      );
    const encrypted = await this.pool.query(`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='yeta_crm' AND table_name IN ('companies','activities','tasks','records','catalog') AND column_name='protected_data' AND is_nullable='NO'`);
    if (encrypted.rows[0]?.count !== 5) throw storageUnavailable();
    await this.encryption.ready();
  }
  async listCompanies(query: ListQuery): Promise<CompanyList> {
    const result = await this.pool.query<Company>(
      `SELECT ${companySelect} FROM yeta_crm.companies WHERE archived_at IS NULL`,
    );
    // Sensitive search/sort fields stay encrypted in PostgreSQL. Filter only the per-request projection.
    const companies = await Promise.all(result.rows.map(row => this.decodeProjection('companies', row)));
    const selected = selectCompanies(companies.map(withoutNullExtensions), query);
    return { ...selected, items: await this.legacy.enrich(selected.items), mode: this.mode };
  }
  async getCompany(id: string) {
    const result = await this.pool.query<Company>(
      `SELECT ${companySelect} FROM yeta_crm.companies WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    if (!result.rows[0]) throw notFound();
    return (await this.legacy.enrich([withoutNullExtensions(await this.decodeProjection('companies', result.rows[0]))]))[0];
  }
  async createCompany(input: CompanyInput) {
    validateContract(input);
    const id = randomUUID();
    const encrypted = await this.encodeProjection('companies', id, input);
    const result = await this.pool.query<Company>(
      `INSERT INTO yeta_crm.companies (id, ${companyKeys.map(key => companyColumns[key]).join(', ')}, protected_data)
      VALUES ($1, ${companyKeys.map((_, index) => `$${index + 2}`).join(', ')}, $${companyKeys.length + 2}::jsonb) RETURNING ${companySelect}`,
      [id, ...companyKeys.map(key => encrypted[companyColumns[key]]), JSON.stringify(encrypted.protected_data)],
    );
    return this.decodeProjection('companies', result.rows[0]);
  }
  async updateCompany(id: string, patch: Partial<CompanyInput>) {
    // Lock the row so simultaneous edits validate against the current contract dates.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<Company>(
        `SELECT ${companySelect} FROM yeta_crm.companies WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!existing.rows[0]) throw notFound();
      const current = await this.decodeProjection('companies', existing.rows[0]);
      validateContract({ ...current, ...patch });
      const encrypted = await this.encodeProjection('companies', id, { ...current, ...patch });
      const keys = companyKeys.filter((key) => key in patch);
      const result = await client.query<Company>(
        `UPDATE yeta_crm.companies SET ${keys.map((key, index) => `${companyColumns[key]} = $${index + 2}`).join(', ')}, protected_data = $${keys.length + 2}::jsonb, updated_at = now()
        WHERE id = $1 RETURNING ${companySelect}`,
        [id, ...keys.map(key => encrypted[companyColumns[key]]), JSON.stringify(encrypted.protected_data)],
      );
      await client.query('COMMIT');
      return (await this.legacy.enrich([withoutNullExtensions(await this.decodeProjection('companies', result.rows[0]))]))[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listAllActivities() {
    const result = await this.pool.query<Activity>(
      `SELECT ${activitySelect} FROM yeta_crm.activities WHERE archived_at IS NULL ORDER BY created_at DESC, id ASC`,
    );
    return this.legacy.enrich(
      (await Promise.all(result.rows.map(row => this.decodeProjection('activities', row)))).map((row) =>
        row.activityDate === null
          ? (Object.fromEntries(
              Object.entries(row).filter(([key]) => key !== 'activityDate'),
            ) as unknown as Activity)
          : row,
      ),
    );
  }
  async listActivities(companyId: string) {
    await this.getCompany(companyId);
    const result = await this.pool.query<Activity>(
      `SELECT ${activitySelect} FROM yeta_crm.activities WHERE company_id = $1 AND archived_at IS NULL ORDER BY created_at DESC, id DESC`,
      [companyId],
    );
    return this.legacy.enrich(
      (await Promise.all(result.rows.map(row => this.decodeProjection('activities', row)))).map((row) =>
        row.activityDate === null
          ? (Object.fromEntries(
              Object.entries(row).filter(([key]) => key !== 'activityDate'),
            ) as unknown as Activity)
          : row,
      ),
    );
  }
  async createActivity(companyId: string, input: ActivityInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const company = await client.query(
        'UPDATE yeta_crm.companies SET updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id',
        [companyId],
      );
      if (!company.rowCount) throw notFound();
      const id = randomUUID();
      const encrypted = await this.encodeProjection('activities', id, input);
      const result = await client.query<Activity>(
        `INSERT INTO yeta_crm.activities (id, company_id, type, title, body, author, activity_date, activity_date_edited, activity_type_edited, protected_data) VALUES ($1,$2,$3,$4,$5,$6,$7,true,true,$8::jsonb) RETURNING ${activitySelect}`,
        [
          id, companyId, input.type, encrypted.title, encrypted.body, encrypted.author,
          encrypted.activity_date, JSON.stringify(encrypted.protected_data),
        ],
      );
      await client.query('COMMIT');
      const { _activityTypeEdited, ...activity } = await this.decodeProjection('activities', result.rows[0]) as Activity & {
        _activityTypeEdited?: boolean;
      };
      return activity;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async updateActivity(id: string, patch: import('./validation.ts').ActivityPatch) {
    const columns = { type: 'type', title: 'title', body: 'body', activityDate: 'activity_date' } as const;
    const keys = (Object.keys(columns) as (keyof typeof columns)[]).filter(key => key in patch);
    if (!keys.length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 항목을 입력해 주세요.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<Activity>(`SELECT ${activitySelect} FROM yeta_crm.activities WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, [id]);
      if (!found.rows[0]) throw notFound();
      const current = await this.decodeProjection('activities', found.rows[0]);
      const merged = { ...current, ...patch };
      const encrypted = await this.encodeProjection('activities', id, merged);
      const result = await client.query<Activity>(
        `UPDATE yeta_crm.activities SET ${keys.map((key,index) => `${columns[key]}=$${index+2}`)
          .concat(...(keys.includes('activityDate') ? ['activity_date_edited=true'] : []), ...(keys.includes('type') ? ['activity_type_edited=true'] : []))
          .join(',')},protected_data=$${keys.length+2}::jsonb WHERE id=$1 AND archived_at IS NULL RETURNING ${activitySelect}`,
        [id, ...keys.map(key => key === 'type' ? merged.type : encrypted[columns[key]]), JSON.stringify(encrypted.protected_data)],
      );
      if (!result.rows[0]) throw notFound();
      await client.query('COMMIT');
      const decoded = await this.decodeProjection('activities', result.rows[0]);
      if (decoded.activityDate === null) delete (decoded as Partial<Activity>).activityDate;
      return (await this.legacy.enrich([decoded]))[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async listTasks() {
    const result = await this.pool.query<Task>(
      `SELECT ${taskSelect} FROM yeta_crm.tasks WHERE archived_at IS NULL ORDER BY completed ASC, due_date ASC NULLS LAST, id ASC`,
    );
    const decoded = await Promise.all(result.rows.map(row => this.decodeProjection('tasks', row)));
    decoded.sort((a,b) => Number(a.completed)-Number(b.completed) || (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : a.dueDate ? -1 : b.dueDate ? 1 : 0) || a.id.localeCompare(b.id));
    return this.legacy.enrich(decoded.map(withoutNullExtensions));
  }
  async createTask(input: TaskInput) {
    if (input.companyId) await this.getCompany(input.companyId);
    if (
      input.contactId &&
      !(
        await this.pool.query(
          "SELECT id FROM yeta_crm.records WHERE kind='contacts' AND id=$1 AND company_id=$2 AND archived_at IS NULL",
          [input.contactId, input.companyId],
        )
      ).rowCount
    )
      throw new ApiError(400, 'INVALID_TASK_CONTACT', '선택한 고객사에 연결된 담당자를 선택해 주세요.');
    if (input.startDate && input.dueDate && input.startDate > input.dueDate)
      throw new ApiError(400, 'INVALID_TASK_DATES', '요청기한은 시작일보다 빠를 수 없습니다.');
    const state = taskState(input);
    const id = randomUUID();
    const encrypted = await this.encodeProjection('tasks', id, { ...input, ...state });
    const created = (
      await this.pool.query<Task>(
        `INSERT INTO yeta_crm.tasks (id, title, company_id, due_date, completed, priority, status, type, owner, body, start_date, contact_id, contact_name, start_date_edited, protected_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14::jsonb) RETURNING ${taskSelect}`,
        [
          id,
          encrypted.title,
          input.companyId || null,
          encrypted.due_date,
          state.completed,
          input.priority,
          state.status,
          state.type,
          encrypted.owner,
          encrypted.body,
          encrypted.start_date,
          input.contactId,
          encrypted.contact_name,
          JSON.stringify(encrypted.protected_data),
        ],
      )
    ).rows[0];
    return this.decodeProjection('tasks', created);
  }
  async updateTask(id: string, patch: Partial<TaskInput>) {
    if (patch.companyId) await this.getCompany(patch.companyId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<Task>(
        `SELECT ${taskSelect} FROM yeta_crm.tasks WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!existing.rows[0]) throw notFound();
      const current = await this.decodeProjection('tasks', existing.rows[0]);
      const reset =
        patch.companyId !== undefined && patch.companyId !== current.companyId
          ? { contactId: '', contactName: '' }
          : {};
      const fields = { ...reset, ...patch, ...taskState(patch, current) };
      const merged = { ...current, ...fields };
      const encrypted = await this.encodeProjection('tasks', id, merged);
      if (
        ('contactId' in patch || 'companyId' in patch) &&
        merged.contactId &&
        !(
          await client.query(
            "SELECT id FROM yeta_crm.records WHERE kind='contacts' AND id=$1 AND company_id=$2 AND archived_at IS NULL",
            [merged.contactId, merged.companyId],
          )
        ).rowCount
      )
        throw new ApiError(400, 'INVALID_TASK_CONTACT', '선택한 고객사에 연결된 담당자를 선택해 주세요.');
      if (
        ('startDate' in patch || 'dueDate' in patch) &&
        merged.startDate &&
        merged.dueDate &&
        merged.startDate > merged.dueDate
      )
        throw new ApiError(400, 'INVALID_TASK_DATES', '요청기한은 시작일보다 빠를 수 없습니다.');
      const columns = {
        title: 'title',
        companyId: 'company_id',
        dueDate: 'due_date',
        startDate: 'start_date',
        contactId: 'contact_id',
        contactName: 'contact_name',
        completed: 'completed',
        priority: 'priority',
        status: 'status',
        type: 'type',
        owner: 'owner',
        body: 'body',
      };
      const keys = (Object.keys(columns) as (keyof TaskInput)[]).filter((key) => key in fields);
      const result = await client.query<Task>(
        `UPDATE yeta_crm.tasks SET ${keys
          .map((key, index) => `${columns[key]} = $${index + 2}`)
          .concat(...(keys.includes('startDate') ? ['start_date_edited = true'] : []))
          .join(', ')}, protected_data=$${keys.length + 2}::jsonb WHERE id = $1 RETURNING ${taskSelect}`,
        [
          id,
          ...keys.map((key) =>
            Object.hasOwn(businessPrivateColumns.tasks, columns[key]) ? encrypted[columns[key]] :
            key === 'companyId' && !fields[key] ? null : fields[key],
          ),
          JSON.stringify(encrypted.protected_data),
        ],
      );
      await client.query('COMMIT');
      return (await this.legacy.enrich([withoutNullExtensions(await this.decodeProjection('tasks', result.rows[0]))]))[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listRecords(kind: RecordKind) {
    const result = await this.pool.query<RecordRow>(
      `SELECT ${recordSelect} FROM yeta_crm.records WHERE kind = $1 AND archived_at IS NULL ORDER BY updated_at DESC, id ASC`,
      [kind],
    );
    const records = await Promise.all(result.rows.map(row => this.fromRecordRow(row)));
    return kind === 'contacts' || kind === 'sales' ? this.legacy.enrich(records) : records;
  }
  async createRecord(kind: RecordKind, input: RecordInput, actor?: { name: string; role: string }) {
    await this.getCompany(input.companyId);
    for (const relatedId of ('relatedCompanyIds' in input ? input.relatedCompanyIds : []) || [])
      await this.getCompany(relatedId);
    if (kind === 'quotations' && actor)
      assertQuotationPermission(actor.role, input as Partial<import('../src/types.ts').QuotationRecord>);
    const record = assembleRecord(kind, input, randomUUID(), undefined, actor?.name);
    const { id, companyId, updatedAt: _updatedAt, ...data } = record;
    const encrypted = await this.encryption.encrypt('records', { kind, id, data });
    const result = await this.pool.query<RecordRow>(
      `INSERT INTO yeta_crm.records (kind, id, company_id, data, protected_data) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING ${recordSelect}`,
      [kind, id, companyId, JSON.stringify(encrypted.data), JSON.stringify(encrypted.protected_data)],
    );
    return this.fromRecordRow(result.rows[0]);
  }
  async createQuotationRevision(sourceId: string, input: RecordInput) {
    await this.getCompany(input.companyId);
    const source = (
      await this.pool.query<RecordRow>(
        `SELECT ${recordSelect} FROM yeta_crm.records WHERE kind='quotations' AND id=$1 AND archived_at IS NULL`,
        [sourceId],
      )
    ).rows[0];
    if (!source) throw notFound();
    const record = quotationRevision(
      await this.fromRecordRow(source) as import('../src/types.ts').QuotationRecord,
      assembleRecord('quotations', input, randomUUID()),
    );
    const { id, companyId, updatedAt: _updatedAt, ...data } = record;
    const encrypted = await this.encryption.encrypt('records', { kind: 'quotations', id, data });
    const result = await this.pool.query<RecordRow>(
      `INSERT INTO yeta_crm.records (kind,id,company_id,data,protected_data) VALUES ('quotations',$1,$2,$3::jsonb,$4::jsonb) RETURNING ${recordSelect}`,
      [id, companyId, JSON.stringify(encrypted.data), JSON.stringify(encrypted.protected_data)],
    );
    return this.fromRecordRow(result.rows[0]);
  }
  async updateRecord(
    kind: RecordKind,
    id: string,
    patch: Partial<RecordInput>,
    actor?: { name: string; role: string },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RecordRow>(
        `SELECT ${recordSelect} FROM yeta_crm.records WHERE kind = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [kind, id],
      );
      if (!result.rows[0]) throw notFound();
      if (
        patch.companyId &&
        !(
          await client.query('SELECT id FROM yeta_crm.companies WHERE id = $1 AND archived_at IS NULL', [
            patch.companyId,
          ])
        ).rowCount
      )
        throw notFound();
      for (const relatedId of ('relatedCompanyIds' in patch ? patch.relatedCompanyIds : []) || []) {
        if (
          !(
            await client.query('SELECT id FROM yeta_crm.companies WHERE id = $1 AND archived_at IS NULL', [
              relatedId,
            ])
          ).rowCount
        )
          throw notFound();
      }
      const original = await this.fromRecordRow(result.rows[0]);
      const existing = original; // Archive projections must never be persisted back into ordinary JSONB.
      if (kind === 'quotations' && actor)
        assertQuotationPermission(
          actor.role,
          patch as Partial<import('../src/types.ts').QuotationRecord>,
          existing as import('../src/types.ts').QuotationRecord,
        );
      const record = assembleRecord(kind, patch, id, existing, actor?.name);
      const { companyId, id: _id, updatedAt: _updatedAt, ...data } = record;
      const encrypted = await this.encryption.encrypt('records', { kind, id, data });
      const updated = await client.query<RecordRow>(
        `UPDATE yeta_crm.records SET company_id = $3, data = $4::jsonb, protected_data=$5::jsonb, updated_at = now() WHERE kind = $1 AND id = $2 RETURNING ${recordSelect}`,
        [kind, id, companyId, JSON.stringify(encrypted.data), JSON.stringify(encrypted.protected_data)],
      );
      await client.query('COMMIT');
      return this.fromRecordRow(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async updateInstallationMetadata(
    id: string,
    patch: Partial<RecordInput>,
    expectedRevision: string,
    actor: { id: string; name: string; role: string },
  ): Promise<CRMRecord> {
    if (actor.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    const validated = installationMetadataRecordPatch(patch);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query<RecordRow>(
          `SELECT ${recordSelect} FROM yeta_crm.records WHERE kind='installations' AND id=$1 AND archived_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!current) throw notFound();
      if (installationMetadataRevision(await this.fromRecordRow(current)) !== expectedRevision)
        throw installationMetadataConflict();
      const administrator = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actor.id])
      ).rows[0];
      if (!administrator || administrator.role !== 'admin' || administrator.status !== 'active')
        throw new ApiError(403, 'ADMIN_REQUIRED', '활성 관리자 권한이 필요합니다.');
      const original = await this.fromRecordRow(current);
      const { id: _id, companyId: _companyId, updatedAt: _updatedAt, ...originalData } = original;
      const encrypted = await this.encryption.encrypt('records', { kind: 'installations', id, data: { ...originalData, ...validated } });
      const updated = await client.query<RecordRow>(
        `UPDATE yeta_crm.records SET data=$2::jsonb, protected_data=$3::jsonb, updated_at=now() WHERE kind='installations' AND id=$1 AND archived_at IS NULL RETURNING ${recordSelect}`,
        [id, JSON.stringify(encrypted.data), JSON.stringify(encrypted.protected_data)],
      );
      if (!updated.rows[0]) throw notFound();
      await client.query(
        "INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result,fields) VALUES($1,'설치 기본정보 수정','installations','완료',$2::jsonb)",
        [actor.id, JSON.stringify(Object.keys(validated))],
      );
      await client.query('COMMIT');
      return this.fromRecordRow(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
