import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import type { PoolConfig } from 'pg';

function connectionDefaults(readOnly: boolean): PoolConfig {
  return {
    connectionTimeoutMillis: 5_000,
    max: 5,
    application_name: readOnly ? 'ieumdesk_readonly_inventory' : 'ieumdesk_local',
    options: `-c statement_timeout=8000${readOnly ? ' -c default_transaction_read_only=on' : ''}`,
  };
}

type JdbcProperties = Record<string, string>;
const legacyMarker = (line: string) =>
  /^(?:CRM_OLD_DB|\[CRM_OLD_DB\]|#{1,6}\s*CRM_OLD_DB)\s*:?\s*$/.test(line.trim());
const sectionHeading = (line: string) => {
  const value = line.trim();
  return (
    legacyMarker(value) ||
    /^\[[^\]]+\]\s*$/.test(value) ||
    /^#{1,6}\s*\S/.test(value) ||
    /^[A-Z][A-Z\d_ -]*:?$/.test(value)
  );
};
function jdbcProperties(raw: string, legacy: boolean): JdbcProperties {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const markers = lines.flatMap((line, index) => (legacyMarker(line) ? [index] : []));
  if (legacy && markers.length !== 1)
    throw new Error(markers.length ? 'LEGACY_DB_SECTION_DUPLICATED' : 'LEGACY_DB_SECTION_MISSING');
  const properties: JdbcProperties = {};
  const begin = legacy ? markers[0] + 1 : 0;
  for (let index = begin; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (sectionHeading(line)) {
      if (legacy || Object.keys(properties).length || legacyMarker(line)) break;
      continue;
    }
    const match = line.match(/^(jdbc\.(?:url|username|password))\s*=(.*)$/);
    if (!match) continue;
    // A new URL starts the next default block. Legacy sections allow only one block.
    if (!legacy && match[1] === 'jdbc.url' && Object.keys(properties).length === 3) break;
    if (Object.hasOwn(properties, match[1]))
      throw new Error(legacy ? 'LEGACY_DB_BLOCK_AMBIGUOUS' : 'DEFAULT_DB_BLOCK_AMBIGUOUS');
    properties[match[1]] = match[2].trim();
  }
  if (!['jdbc.url', 'jdbc.username', 'jdbc.password'].every((key) => Boolean(properties[key]))) {
    throw new Error(legacy ? 'LEGACY_DB_CONFIGURATION_INCOMPLETE' : 'DB_CONFIGURATION_INCOMPLETE');
  }
  return properties;
}

function jdbcConfiguration(
  properties: JdbcProperties,
  readOnly: boolean,
  databaseOverride?: string,
): PoolConfig {
  try {
    const url = new URL(properties['jdbc.url'].replace(/^jdbc:/, ''));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length <= 1 ||
      url.username ||
      url.password
    )
      throw new Error();
    return {
      ...connectionDefaults(readOnly),
      host: url.hostname,
      port: Number(url.port || 5432),
      database: databaseOverride || decodeURIComponent(url.pathname.slice(1)),
      user: properties['jdbc.username'],
      password: properties['jdbc.password'],
      ...(url.searchParams.get('sslmode') === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
    };
  } catch {
    // URL parser exceptions may contain credentials. Emit a fixed error instead.
    throw new Error('DB_CONFIGURATION_INVALID');
  }
}

async function readInfoFile() {
  const file = process.env.DB_INFO_FILE?.trim();
  if (!file) throw new Error('DB_INFO_FILE_REQUIRED');
  return readFile(file, 'utf8');
}

// Credentials stay in the user-owned source file; never copy them into the project.
export async function databaseConfig(readOnly = false): Promise<PoolConfig> {
  // An explicit DATABASE_URL is authoritative, including its database name.
  // CRM_DATABASE overrides only the database named in the external JDBC info file.
  if (process.env.DATABASE_URL)
    return { ...connectionDefaults(readOnly), connectionString: process.env.DATABASE_URL };
  return jdbcConfiguration(jdbcProperties(await readInfoFile(), false), readOnly, process.env.CRM_DATABASE);
}

// Legacy source selection deliberately ignores target DATABASE_URL and CRM_DATABASE.
// Callers receive a read-only connection by default; this never opens a connection.
export async function legacyDatabaseConfig(readOnly = true): Promise<PoolConfig> {
  return jdbcConfiguration(jdbcProperties(await readInfoFile(), true), readOnly);
}

// Manual provisioning needs a second connection to the newly created database.
// This explicit helper is never called by ordinary application startup.
export function configForDatabase(configuration: PoolConfig, database: string): PoolConfig {
  if (!/^[a-z_][a-z\d_]{0,62}$/.test(database)) throw new Error('INVALID_DATABASE_NAME');
  if (configuration.connectionString) {
    const url = new URL(configuration.connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_URL');
    url.pathname = `/${database}`;
    return { ...configuration, connectionString: url.toString(), database };
  }
  return { ...configuration, database };
}
