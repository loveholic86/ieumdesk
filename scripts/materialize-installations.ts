import 'dotenv/config';
import pg, { type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { databaseConfig } from '../server/config.ts';
import { BackupFiles, type BackupFile } from '../server/backup-files.ts';
import { openLegacyVault, type LegacyVault } from '../server/legacy-vault.ts';
import {
  InstallationDetailsService,
  type InstallationArchiveRepository,
} from '../server/installation-details.ts';
import {
  InstallationWorkspaceService,
  protectInstallationDetails,
  type InstallationWorkspaceRepository,
  type InstallationMaterialization,
} from '../server/installation-workspace.ts';
import {
  managedInstallationSchema,
  managedInstallationCounts,
  managedInstallationDetails,
} from '../server/installation-managed.ts';
import { decryptBusinessRow, encryptBusinessRow } from '../server/business-encryption.ts';
import { installationMetadataRecordPatch } from '../server/installation-metadata.ts';

type SqlClient = Pick<PoolClient, 'query'>;
export interface MaterializationArguments {
  apply: boolean;
  expectedCount: number;
  expectedFingerprint?: string;
  actorId?: string;
}
export type PreparedInstallation = InstallationMaterialization;
export interface Materializer {
  prepareMaterialization(id: string): Promise<PreparedInstallation>;
}
type FileAccess = Pick<BackupFiles, 'lock' | 'capture'>;
type Fingerprint = { table: string; count: string; digest: string };
type Projection = { changedIds: string[]; metadataKeys: Record<string, string[]>; newAuditIds: string[] };
const fail = (code: string): never => {
  throw new Error(`INSTALLATION_MATERIALIZATION_${code}`);
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
const excludedTables = new Set(['yeta_crm_private.backup_history', 'yeta_crm_private.backup_schedule']);
const writableTables = new Set([
  'yeta_crm.records',
  'yeta_crm_private.installation_workspace',
  'yeta_crm_private.installation_workspace_audit',
]);
const inputTables = new Set([
  'yeta_crm.records',
  'yeta_crm_private.installation_workspace',
  'yeta_crm_private.legacy_archive',
  'yeta_crm_private.legacy_items',
  'yeta_crm_private.legacy_runs',
]);
const archiveTables = [
  'setup_tb',
  'setup_cominfo_tb',
  'ct_yetalogin_tb',
  'ct_sap_tb',
  'setup_setting_tb',
  'setting_file_tb',
  'code_tb',
];
const workspaceContext = (id: string, revision: number) => ({
  source: 'yeta-crm-workspace:v1',
  table: 'installation_workspace',
  primaryKey: id,
  batchId: String(revision),
});
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Default execution is read-only. Applying always requires a reviewed plan fingerprint. */
export function parseMaterializationArguments(args: string[]): MaterializationArguments {
  const result: MaterializationArguments = { apply: false, expectedCount: 259 };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (seen.has(key)) fail('ARGUMENT_INVALID');
    seen.add(key);
    if (key === '--apply') result.apply = true;
    else if (key === '--expected-fingerprint') {
      const value = args[++index];
      if (!digest(value)) fail('ARGUMENT_INVALID');
      result.expectedFingerprint = value;
    } else if (key === '--actor-id') {
      const value = args[++index];
      if (!uuid(value)) fail('ARGUMENT_INVALID');
      result.actorId = value;
    } else if (key === '--expected-count') {
      const value = args[++index];
      if (!/^(?:0|[1-9]\d{0,5})$/.test(value ?? '')) fail('ARGUMENT_INVALID');
      result.expectedCount = Number(value);
    } else fail('ARGUMENT_INVALID');
  }
  if (result.apply && !result.expectedFingerprint) fail('EXPECTED_FINGERPRINT_REQUIRED');
  return result;
}

function relation(table: string) {
  const parts = table.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[a-z_][a-z\d_]*$/.test(part))) fail('SCHEMA_UNSUPPORTED');
  return parts.map((part) => `"${part}"`).join('.');
}

async function tableNames(client: SqlClient) {
  const rows = (
    await client.query(
      "SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('yeta_crm','yeta_crm_private') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname",
    )
  ).rows;
  const tables = rows.map((row) => String(row.name)).filter((table) => !excludedTables.has(table));
  if (
    [...writableTables, ...inputTables, 'yeta_crm.auth_users', 'yeta_crm.auth_sessions'].some(
      (table) => !tables.includes(table),
    )
  )
    fail('SCHEMA_INCOMPLETE');
  tables.forEach(relation);
  return tables;
}

/** Credentials and session contents are hashed inside PostgreSQL and never returned. */
export async function installationFingerprints(
  client: SqlClient,
  tables: string[],
  projection?: Projection,
): Promise<Fingerprint[]> {
  const values: Fingerprint[] = [];
  for (const table of tables) {
    let expression = 'to_jsonb(t)',
      where = '';
    const parameters: unknown[] = [];
    if (projection && table === 'yeta_crm.records') {
      parameters.push(JSON.stringify(projection.metadataKeys));
      expression =
        "CASE WHEN t.kind='installations' AND $1::jsonb ? t.id THEN (to_jsonb(t)-'data'-'updated_at'-'protected_data')||jsonb_build_object('data',t.data-ARRAY(SELECT jsonb_array_elements_text($1::jsonb->t.id))) ELSE to_jsonb(t) END";
    } else if (projection && table === 'yeta_crm_private.installation_workspace') {
      parameters.push(projection.changedIds);
      where = ' WHERE NOT (t.installation_id=ANY($1::text[]))';
    } else if (projection && table === 'yeta_crm_private.installation_workspace_audit') {
      parameters.push(projection.newAuditIds);
      where = ' WHERE NOT (t.id=ANY($1::bigint[]))';
    }
    const row = (
      await client.query(
        `SELECT count(*)::text AS count,encode(sha256(convert_to(COALESCE(string_agg(row_hash,'' ORDER BY row_hash),''),'UTF8')),'hex') AS digest FROM (SELECT encode(sha256(convert_to((${expression})::text,'UTF8')),'hex') AS row_hash FROM ${relation(table)} t${where}) hashed_rows`,
        parameters,
      )
    ).rows[0];
    if (!row || !/^\d+$/.test(row.count) || !digest(row.digest)) fail('FINGERPRINT_INVALID');
    values.push({ table, count: row.count, digest: row.digest });
  }
  return values;
}

export function filesFingerprint(files: BackupFile[]) {
  return sha(
    canonical(
      files
        .map((file) => ({ root: file.root, name: file.name, sha256: file.sha256 }))
        .sort((a, b) => `${a.root}/${a.name}`.localeCompare(`${b.root}/${b.name}`)),
    ),
  );
}

export function materializationFingerprint(
  prepared: PreparedInstallation[],
  inputs: Fingerprint[],
  files: string,
) {
  return sha(
    canonical({
      version: 1,
      files,
      inputs: inputs.filter((input) => inputTables.has(input.table)),
      installations: prepared
        .map((item) => ({
          id: item.id,
          revision: item.expectedRevision,
          fingerprint: item.fingerprint,
          metadataPatch: item.metadataPatch,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}

type InstallationMetadataRow = { id: string; data: Record<string, unknown>; protected_data?: unknown };
const metadataColumns = "id,data,to_jsonb(records)->'protected_data' AS protected_data";
function decodeMetadata(vault: LegacyVault, row: InstallationMetadataRow): InstallationMetadataRow {
  return row.protected_data == null ? row : decryptBusinessRow(vault, 'records', { ...row, kind: 'installations' }) as InstallationMetadataRow;
}
async function metadataRows(client: SqlClient, ids: string[]) {
  return (await client.query<InstallationMetadataRow>(
    `SELECT ${metadataColumns} FROM yeta_crm.records WHERE kind='installations' AND id=ANY($1::text[]) AND archived_at IS NULL ORDER BY id`, [ids],
  )).rows;
}
function preservedMetadata(vault: LegacyVault, rows: InstallationMetadataRow[], keys: Record<string, string[]>) {
  return rows.map(row => {
    const data = { ...decodeMetadata(vault, row).data };
    for (const key of keys[row.id] ?? []) delete data[key];
    return { id: row.id, data };
  }).sort((a,b) => a.id.localeCompare(b.id));
}

/** Read adapters use exactly the caller's transaction; none creates a connection or writes. */
export function createMaterializer(
  client: SqlClient,
  vault: LegacyVault,
  schemaFile?: string,
  operationalOnly = false,
): InstallationWorkspaceService {
  const forbidden = async (): Promise<never> => fail('PREPARATION_WRITE_FORBIDDEN');
  type Metadata = InstallationMetadataRow;
  type Workspace = NonNullable<Awaited<ReturnType<InstallationWorkspaceRepository['get']>>>;
  let ready: Promise<{ records: Map<string, Metadata>; workspaces: Map<string, Workspace> }> | undefined;
  const snapshot = () =>
    (ready ??= (async () => {
      const records = (
        await client.query<Metadata>(
          `SELECT ${metadataColumns} FROM yeta_crm.records WHERE kind='installations' AND archived_at IS NULL ORDER BY id`,
        )
      ).rows;
      const workspaces = (
        await client.query<Workspace & { installation_id: string }>(
          'SELECT installation_id,revision,envelope FROM yeta_crm_private.installation_workspace WHERE installation_id=ANY($1::text[]) ORDER BY installation_id',
          [records.map((row) => row.id)],
        )
      ).rows;
      if (
        new Set(records.map((row) => row.id)).size !== records.length ||
        new Set(workspaces.map((row) => row.installation_id)).size !== workspaces.length
      )
        fail('PREPARATION_INVALID');
      return {
        records: new Map(records.map((row) => [row.id, decodeMetadata(vault, row)])),
        workspaces: new Map(
          workspaces.map((row) => [row.installation_id, { revision: row.revision, envelope: row.envelope }]),
        ),
      };
    })());
  type SourceLink = {
    target_id: string;
    source_key: string;
    id: string;
    source: string;
    fingerprint: string;
    key_id: string;
    report: { status: string; sourceCounts: Record<string, number> };
  };
  let linkedReady: Promise<Map<string, SourceLink[]>> | undefined;
  const sourceLinks = () =>
    (linkedReady ??= (async () => {
      // This third bulk read is lazy: existing v2 documents never consult legacy links.
      const rows = (
        await client.query<SourceLink>(
          "SELECT i.target_id,i.source_key,r.id,r.source,r.fingerprint,r.key_id,r.report FROM yeta_crm_private.legacy_items i JOIN yeta_crm_private.legacy_runs r ON r.id=i.batch_id WHERE i.target_table='records' AND i.target_kind='installations' AND i.source_table='setup_tb' ORDER BY i.target_id",
        )
      ).rows;
      const links = new Map<string, SourceLink[]>();
      for (const row of rows) links.set(row.target_id, [...(links.get(row.target_id) ?? []), row]);
      return links;
    })());
  const repository: InstallationArchiveRepository = {
    async installation(id) {
      const record = (await snapshot()).records.get(id);
      if (!record) return undefined;
      const linked = (await sourceLinks()).get(id) ?? [];
      if (linked.length > 1) fail('SOURCE_LINK_INVALID');
      if (!linked.length) return structuredClone(record);
      const batch = linked[0];
      if (
        batch.source !== 'CRM_OLD_DB:public:v1' ||
        batch.report?.status !== 'committed' ||
        typeof batch.source_key !== 'string' ||
        !/^-?\d+$/.test(batch.source_key) ||
        !batch.report?.sourceCounts
      )
        fail('SOURCE_LINK_INVALID');
      return {
        id: record.id,
        data: structuredClone(record.data),
        batch: {
          id: batch.id,
          source: batch.source,
          fingerprint: batch.fingerprint,
          keyId: batch.key_id,
          setupKey: batch.source_key,
          sourceCounts: batch.report.sourceCounts,
        },
      };
    },
    async archives(batchId) {
      return (
        await client.query(
          'SELECT source_table,source_key,envelope FROM yeta_crm_private.legacy_archive WHERE batch_id=$1 AND source_table=ANY($2::text[]) ORDER BY source_table,source_key',
          [batchId, archiveTables],
        )
      ).rows;
    },
    audit: forbidden,
  };
  const workspace: InstallationWorkspaceRepository = {
    async get(id) {
      const row = (await snapshot()).workspaces.get(id);
      return row ? structuredClone(row) : undefined;
    },
    save: forbidden,
  };
  const metadata = {
    async read(id: string) {
      const row = (await snapshot()).records.get(id);
      if (!row) fail('INSTALLATION_NOT_FOUND');
      return structuredClone(row!.data);
    },
    update: forbidden,
  };
  const options = { vault: async () => vault, metadata };
  const base = operationalOnly
    ? { details: forbidden, secrets: forbidden, audit: forbidden }
    : new InstallationDetailsService(repository, { vault: async () => vault, schemaFile });
  return new InstallationWorkspaceService(base, workspace, options);
}

function validatePrepared(item: PreparedInstallation, id: string, vault: LegacyVault) {
  if (
    item.id !== id ||
    !digest(item.fingerprint) ||
    !Number.isInteger(item.expectedRevision) ||
    item.expectedRevision < 0 ||
    item.expectedRevision >= 2_147_483_647 ||
    ![item.rowCount, item.fieldCount, item.preservedEdits].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    fail('PREPARATION_INVALID');
  const patch = installationMetadataRecordPatch(item.metadataPatch);
  if (!same(patch, item.metadataPatch)) fail('METADATA_PATCH_INVALID');
  if (item.alreadyMaterialized) {
    if (
      item.expectedRevision < 1 ||
      item.nextRevision !== item.expectedRevision ||
      item.envelope ||
      Object.keys(patch).length
    )
      fail('PREPARATION_INVALID');
  } else {
    if (item.nextRevision !== item.expectedRevision + 1 || !item.envelope) fail('PREPARATION_INVALID');
    const state = managedInstallationSchema.parse(
      JSON.parse(vault.decrypt(item.envelope!, workspaceContext(id, item.nextRevision))),
    );
    if (!same(managedInstallationCounts(state), { rowCount: item.rowCount, fieldCount: item.fieldCount }))
      fail('SNAPSHOT_COUNTS_INVALID');
  }
}

async function activeActor(client: SqlClient, requested?: string, lock = false): Promise<string> {
  const rows = (
    await client.query(
      `SELECT id FROM yeta_crm.auth_users WHERE role='admin' AND status='active'${requested ? ' AND id=$1::text' : ''} ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      requested ? [requested] : [],
    )
  ).rows;
  if (rows.length !== 1 || !uuid(rows[0]?.id)) fail('ACTIVE_ADMIN_REQUIRED');
  return rows[0].id;
}

/** All changes and validations share one transaction. The caller owns connection teardown. */
export async function materializeInstallations(
  client: SqlClient,
  vault: LegacyVault,
  files: FileAccess,
  options: MaterializationArguments,
  factory: (client: SqlClient, vault: LegacyVault) => Materializer = createMaterializer,
  closeConnection?: () => Promise<void>,
) {
  let release: (() => Promise<void>) | undefined;
  let transaction = false,
    commitAttempted = false,
    committed = false;
  const closeUncertain = async () => {
    let closed = false;
    try {
      if (closeConnection) {
        await closeConnection();
        closed = true;
      }
    } catch {
      /* Retain locks when connection teardown cannot be confirmed. */
    }
    if (!closed) release = undefined;
  };
  try {
    if (options.apply && !digest(options.expectedFingerprint)) fail('EXPECTED_FINGERPRINT_REQUIRED');
    if (options.apply) release = await files.lock();
    await client.query(
      options.apply
        ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transaction = true;
    await client.query("SET LOCAL statement_timeout='60000'");
    await client.query("SET LOCAL lock_timeout='10000'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle='ISO, YMD'");
    if ((await client.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
      fail('DATABASE_MISMATCH');
    if (options.apply)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('yeta-crm:installation-materialization:v2'))",
      );
    const tables = await tableNames(client);
    if (options.apply) {
      // Stable ordering avoids taking a weaker lock and later upgrading it.
      for (const table of tables)
        await client.query(
          `LOCK TABLE ${relation(table)} IN ${writableTables.has(table) ? 'SHARE ROW EXCLUSIVE' : 'SHARE'} MODE`,
        );
      if (!same(tables, await tableNames(client))) fail('SCHEMA_CHANGED');
    }
    const actor = await activeActor(client, options.actorId, options.apply);
    const ids = (
      await client.query(
        "SELECT id FROM yeta_crm.records WHERE kind='installations' AND archived_at IS NULL ORDER BY id",
      )
    ).rows.map((row) => String(row.id));
    if (ids.length !== options.expectedCount || new Set(ids).size !== ids.length) fail('COUNT_MISMATCH');
    const allBefore = await installationFingerprints(client, tables);
    const beforeFiles = filesFingerprint(await files.capture());
    const service = factory(client, vault),
      prepared: PreparedInstallation[] = [];
    for (const id of ids) {
      const item = await service.prepareMaterialization(id);
      validatePrepared(item, id, vault);
      prepared.push(item);
    }
    if (beforeFiles !== filesFingerprint(await files.capture())) fail('FILES_CHANGED');
    const fingerprint = materializationFingerprint(prepared, allBefore, beforeFiles);
    const changed = prepared.filter((item) => !item.alreadyMaterialized);
    const metadataChanges = changed.filter((item) => Object.keys(item.metadataPatch).length);
    const report = {
      version: 1,
      status: options.apply ? 'committed' : 'planned',
      fingerprint,
      installations: ids.length,
      toMaterialize: changed.length,
      alreadyMaterialized: ids.length - changed.length,
      metadataRecordsUpdated: metadataChanges.length,
      rows: prepared.reduce((count, item) => count + item.rowCount, 0),
      fields: prepared.reduce((count, item) => count + item.fieldCount, 0),
      preservedEdits: prepared.reduce((count, item) => count + item.preservedEdits, 0),
      auditRowsAdded: options.apply ? changed.length : 0,
      verification: {
        encryptedSnapshotsValidated: true,
        allOtherDatabaseRowsUnchanged: true,
        existingAuditRowsUnchanged: true,
        filesUnchanged: true,
        operationalReadsIndependentOfArchive: options.apply,
        originalSourceConnected: false,
      },
    };
    if (!options.apply) {
      await client.query('ROLLBACK');
      transaction = false;
      return report;
    }
    if (options.expectedFingerprint !== fingerprint) fail('PLAN_STALE');
    const projection: Projection = {
      changedIds: changed.map((item) => item.id),
      metadataKeys: Object.fromEntries(
        metadataChanges.map((item) => [item.id, Object.keys(item.metadataPatch).sort()]),
      ),
      newAuditIds: [],
    };
    const metadataBefore = await metadataRows(client, ids);
    const privateBefore = preservedMetadata(vault, metadataBefore, projection.metadataKeys);
    const preservedBefore = await installationFingerprints(client, tables, projection);
    if ((await activeActor(client, actor, true)) !== actor) fail('ACTIVE_ADMIN_REQUIRED');
    for (const item of changed) {
      const parameters = [item.id, item.nextRevision, item.envelope, actor];
      const saved =
        item.expectedRevision === 0
          ? await client.query(
              'INSERT INTO yeta_crm_private.installation_workspace(installation_id,revision,envelope,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(installation_id) DO NOTHING RETURNING installation_id',
              parameters,
            )
          : await client.query(
              'UPDATE yeta_crm_private.installation_workspace SET revision=$2,envelope=$3,updated_by=$4,updated_at=now() WHERE installation_id=$1 AND revision=$5 RETURNING installation_id',
              [...parameters, item.expectedRevision],
            );
      if (saved.rowCount !== 1 || saved.rows[0]?.installation_id !== item.id) fail('REVISION_CONFLICT');
      const patch = installationMetadataRecordPatch(item.metadataPatch);
      if (Object.keys(patch).length) {
        const original = metadataBefore.find(row => row.id === item.id) ?? fail('METADATA_WRITE_FAILED');
        const sealed = original.protected_data == null ? undefined : encryptBusinessRow(vault, 'records', {
          id: item.id, kind: 'installations', data: { ...decodeMetadata(vault, original).data, ...patch },
        });
        const updated = sealed ? await client.query(
          "UPDATE yeta_crm.records SET data=$2::jsonb,protected_data=$3::jsonb,updated_at=now() WHERE kind='installations' AND id=$1 AND archived_at IS NULL RETURNING id",
          [item.id, JSON.stringify(sealed.data), JSON.stringify(sealed.protected_data)],
        ) : await client.query(
          "UPDATE yeta_crm.records SET data=data||$2::jsonb,updated_at=now() WHERE kind='installations' AND id=$1 AND archived_at IS NULL RETURNING id",
          [item.id, JSON.stringify(patch)],
        );
        if (updated.rowCount !== 1 || updated.rows[0]?.id !== item.id) fail('METADATA_WRITE_FAILED');
      }
      const audit = await client.query(
        "INSERT INTO yeta_crm_private.installation_workspace_audit(installation_ref_hash,actor_user_id,action,revision) VALUES($1,$2,'materialize',$3) RETURNING id",
        [sha(item.id), actor, item.nextRevision],
      );
      const auditId = String(audit.rows[0]?.id ?? '');
      if (audit.rowCount !== 1 || !/^[1-9]\d*$/.test(auditId) || projection.newAuditIds.includes(auditId))
        fail('AUDIT_WRITE_FAILED');
      projection.newAuditIds.push(auditId);
    }
    // Compare every protected row, including archived installations and all login records.
    if (!same(preservedBefore, await installationFingerprints(client, tables, projection)))
      fail('PRESERVATION_FAILED');
    const savedWorkspaces = new Map(
      (
        await client.query(
          'SELECT installation_id,revision,envelope,updated_by FROM yeta_crm_private.installation_workspace WHERE installation_id=ANY($1::text[]) ORDER BY installation_id',
          [ids],
        )
      ).rows.map((row) => [String(row.installation_id), row]),
    );
    const metadataAfter = await metadataRows(client, ids);
    if (!same(privateBefore, preservedMetadata(vault, metadataAfter, projection.metadataKeys)))
      fail('PRESERVATION_FAILED');
    const savedMetadata = new Map(metadataAfter.map(row => [row.id, decodeMetadata(vault, row).data]));
    if (savedWorkspaces.size !== ids.length || savedMetadata.size !== ids.length)
      fail('WORKSPACE_VERIFICATION_FAILED');
    for (const item of changed) {
      const stored = savedWorkspaces.get(item.id);
      if (
        !stored ||
        stored.revision !== item.nextRevision ||
        stored.updated_by !== actor ||
        !same(stored.envelope, item.envelope)
      )
        fail('WORKSPACE_VERIFICATION_FAILED');
      managedInstallationSchema.parse(
        JSON.parse(vault.decrypt(stored.envelope, workspaceContext(item.id, stored.revision))),
      );
      if (
        Object.entries(item.metadataPatch).some(
          ([key, value]) => !same(savedMetadata.get(item.id)?.[key], value),
        )
      )
        fail('METADATA_VERIFICATION_FAILED');
    }
    const audits = (
      await client.query(
        'SELECT installation_ref_hash,actor_user_id,action,revision FROM yeta_crm_private.installation_workspace_audit WHERE id=ANY($1::bigint[]) ORDER BY installation_ref_hash,revision',
        [projection.newAuditIds],
      )
    ).rows;
    const expectedAudits = changed
      .map((item) => ({
        installation_ref_hash: sha(item.id),
        actor_user_id: actor,
        action: 'materialize',
        revision: item.nextRevision,
      }))
      .sort(
        (a, b) => a.installation_ref_hash.localeCompare(b.installation_ref_hash) || a.revision - b.revision,
      );
    if (!same(audits, expectedAudits)) fail('AUDIT_VERIFICATION_FAILED');
    // Force the original-details dependency to throw; every v2 row must stand alone.
    const operational = createMaterializer(client, vault, undefined, true);
    for (const item of prepared) {
      const envelope = item.envelope ?? savedWorkspaces.get(item.id)?.envelope;
      const state = managedInstallationSchema.parse(
        JSON.parse(vault.decrypt(envelope, workspaceContext(item.id, item.nextRevision))),
      );
      const record = savedMetadata.get(item.id);
      if (!record) fail('OPERATIONAL_READ_FAILED');
      const details = await operational.details(item.id, { protected: false, raw: true });
      const expected = managedInstallationDetails(item.id, state, item.nextRevision, record, true);
      if (
        !same(details, expected) ||
        details.revision !== item.nextRevision ||
        details.sections.reduce((count, section) => count + section.rows.length, 0) !== item.rowCount ||
        details.sections
          .flatMap((section) => section.rows)
          .reduce((count, row) => count + row.fields.length, 0) !== item.fieldCount
      )
        fail('OPERATIONAL_READ_FAILED');
      const protectedDetails = await operational.details(item.id, { protected: true });
      const expectedProtected = protectInstallationDetails(
        managedInstallationDetails(item.id, state, item.nextRevision, record),
      );
      if (
        !same(protectedDetails, expectedProtected) ||
        protectedDetails.sections
          .flatMap((section) => section.rows)
          .flatMap((row) => row.fields)
          .some((field) => field.secret && field.present && (!field.masked || field.value !== '••••••••'))
      )
        fail('PROTECTION_VERIFICATION_FAILED');
    }
    if (beforeFiles !== filesFingerprint(await files.capture())) fail('FILES_CHANGED');
    if ((await activeActor(client, actor, true)) !== actor) fail('ACTIVE_ADMIN_REQUIRED');
    if (!same(tables, await tableNames(client))) fail('SCHEMA_CHANGED');
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    transaction = false;
    return report;
  } catch (error) {
    if (transaction && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        await closeUncertain();
        fail('ROLLBACK_UNCERTAIN');
      }
    }
    if (commitAttempted && !committed) {
      // Do not release global file locks while an unresolved database connection is alive.
      await closeUncertain();
      fail('COMMIT_UNCERTAIN');
    }
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        fail(committed ? 'COMMITTED_LOCK_RELEASE_FAILED' : 'LOCK_RELEASE_FAILED');
      }
    }
  }
}

async function main() {
  const args = parseMaterializationArguments(process.argv.slice(2));
  const vault = await openLegacyVault({ createIfMissing: false });
  const client = new pg.Client({
    ...(await databaseConfig(!args.apply)),
    application_name: 'ieumdesk_installation_materialization',
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const report = await materializeInstallations(
      client,
      vault,
      new BackupFiles(),
      args,
      createMaterializer,
      () => client.end(),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await client.end().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message =
      error instanceof Error && /^INSTALLATION_MATERIALIZATION_[A-Z_]+$/.test(error.message)
        ? error.message
        : typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
          ? `INSTALLATION_MATERIALIZATION_DATABASE_ERROR_${error.code}`
          : error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message)
            ? `INSTALLATION_MATERIALIZATION_${error.message}`
            : 'INSTALLATION_MATERIALIZATION_FAILED';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
