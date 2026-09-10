# ieumdesk

[한국어](README.md) | **English**

A CRM that connects companies, contacts, sales, quotations, tasks and customer support. Built with React, TypeScript, Express and PostgreSQL.

Real customer data, accounts, sessions, database credentials, encryption keys, attachments and backups are not included in this repository.

## Run locally

Requires Node.js 22.12 or later.

```sh
npm ci
cp .env.example .env
npm run dev
```

A fresh installation defaults to `demo` mode with synthetic data. If you already have an `.env` file, update the settings you need instead of overwriting it.

- Web UI: http://127.0.0.1:5173
- API: http://127.0.0.1:3001
- Create your own administrator account on first access. No default credentials are provided.
- Subsequent registrations require approval. An administrator manages roles and account status.
- Demo data and encryption keys are created in the Git-excluded `.local/` directory.

The API listens on the local loopback interface only. Production HTTPS and domain configuration require separate setup; startup with `NODE_ENV=production` is currently blocked.

## Interface language

Choose **한국어** or **English** from the language selector on the sign-in page or in the workspace header. Your selection is stored in this browser and retained after a refresh. Changing the language keeps the current page and unsaved form input.

Navigation, forms, notices, validation messages and date formatting follow the selected language. Customer names, notes, attachments and other user-entered content keep their original text. Stored status values, amounts and API payloads do not change; monetary amounts remain in KRW.

## Display names

Administrators can change the brand and workspace names under **Settings → Display & menus → Display names**. The defaults are `ieumdesk` and `Workspace`, with a maximum of 60 characters per name. Saved names appear in the sidebar for all users; the brand name also appears in the browser title, footer and help after sign-in. Custom names are not translated when the interface language changes.

Existing installations retain their protection and menu settings while receiving the new display defaults. The names extend the existing PostgreSQL JSON settings, so no schema migration is required.

## Features

| Area                 | Features                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| Overview             | Customer summary, upcoming contract renewals and active tasks                           |
| Companies & contacts | Search, filters, sorting, editing, relationships and contact history                    |
| Activities & tasks   | Calls, meetings, notes, owners, due dates and progress                                  |
| Sales & quotations   | Sales stages, projected revenue, item and discount calculations, approval and printing  |
| Installations        | Installation, access, server and integration details, editing and encrypted attachments |
| Support              | Inquiries, notices, answers, comments, status, attachments and trash                    |
| Settings             | Roles, protected-information masking, menus, products, codes and backup management      |

Protected information and downloads are subject to role permissions and workspace protection settings. Administrators, editors and viewers have different access and editing permissions.

## Data and PostgreSQL

`CRM_DATA_MODE=demo` uses synthetic file storage under `.local/`. `CRM_DATA_MODE=postgres` uses the dedicated PostgreSQL schema. Connection or required-schema failures do not fall back to demo mode.

Configure database access in your private `.env` file or process environment using either:

- `DATABASE_URL`: the complete connection string. It takes precedence over other database settings, including the database name.
- `DB_INFO_FILE`: the path to a private JDBC properties file read by the server. It uses `jdbc.url`, `jdbc.username` and `jdbc.password`. Never commit this file.

The database and schema identifiers remain `yeta_crm` and `yeta_crm_private` for compatibility. `CRM_DATABASE` overrides the target database name only when using the properties-file configuration.

`db/` contains schema definitions. `scripts/` contains explicit tools for database provisioning, schema updates, storage conversion, encryption and backups. Server startup does not run migrations automatically. SQL files have dependencies and must not be applied indiscriminately in numerical order. Use the planning, verification and apply procedure in `scripts/encrypt-storage.ts` for storage encryption migration.

Before running database provisioning, storage conversion or restore tools against existing data, review the target, preconditions, backup and recovery procedure.

## Development commands

```sh
npm run build
```

- `npm run build`: TypeScript checking and Vite bundling
- `npm start`: start the API only
- `npm run db:inspect`: inspect the configured database's metadata
- `npm run format`: format project code

Actual PostgreSQL behavior, external integrations and production deployment need separate verification. Email verification, password recovery, SSO, email and push delivery, external-system access and remote updates are not connected. Scheduled backups run while the application is running; off-site storage and key recovery require separate arrangements.

## Project structure

- `src/`: React screens, client logic and interface translations
- `server/`: API, authentication, permissions, storage, encryption and backups
- `db/`: PostgreSQL schema definitions
- `scripts/`: database provisioning, schema updates, encryption and backup tools
- [LICENSE](LICENSE): Apache-2.0
