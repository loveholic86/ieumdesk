# ieumdesk

[한국어](README.md) | **English**

A CRM that connects companies, contacts, sales, quotations, tasks and customer support. Built with React, TypeScript, Express and PostgreSQL.

## Run locally

Requires Node.js 22.12 or later.

```sh
npm ci
cp .env.example .env
npm run dev
```

A fresh installation defaults to `demo` mode with synthetic data. If you already have an `.env` file, update the settings you need instead of overwriting it.

- Web UI: http://127.0.0.1:5173
- Other computers or phones on the same LAN: `http://SERVER-LAN-IP:5173` (for example, `http://192.168.0.10:5173`)
- API: http://127.0.0.1:3001
- Create your own administrator account on first access. No default credentials are provided.
- Subsequent registrations require approval. An administrator manages roles and account status.
- Demo data and encryption keys are created in the Git-excluded `.local/` directory.

`npm run dev` also exposes the web server on the LAN. Only loopback names and private IPv4 addresses assigned to the server computer (`10.*`, `172.16.*`–`172.31.*`, `192.168.*`) are accepted. Find the LAN IP in the computer's network settings and use the new address if it changes. If another device cannot connect, check that it is on the same network and that the server firewall permits TCP 5173. Guest Wi-Fi client isolation can also prevent access.

The API still listens on `127.0.0.1:3001` and is reached through the web server's `/api` proxy, so other devices use only port 5173. Authentication, permissions and request-origin checks remain in place. LAN access uses HTTP and is intended for trusted networks. Public internet deployment requires separate HTTPS and domain configuration; startup with `NODE_ENV=production` is currently blocked.

To return to access from this computer only, stop the running servers, then run `npm run dev:server` and `npm run dev:client -- --host 127.0.0.1` in separate terminals.

## Interface language

Choose **한국어** or **English** from the language selector on the sign-in page or in the workspace header. Your selection is stored in this browser and retained after a refresh. Changing the language keeps the current page and unsaved form input.

Navigation, forms, notices, validation messages and date formatting follow the selected language. Customer names, notes, attachments and other user-entered content keep their original text. Stored status values, amounts and API payloads do not change; monetary amounts remain in KRW.

## Display names

Administrators can change the brand and workspace names under **Settings → General settings → Display names**. The defaults are `ieumdesk` and `Workspace`, with a maximum of 60 characters per name. Saved names appear on the sign-in and registration pages and in the sidebar for all users; the brand name also appears in the browser title, footer and help. Only the two display names are available before sign-in; other workspace settings require authentication. Custom names are not translated when the interface language changes.

Existing installations retain their protection and menu settings while receiving the new display defaults. The names extend the existing PostgreSQL JSON settings, so no schema migration is required.

## Features

### Remember ID and automatic logout

- Select **Remember ID** before signing in to save your email in this browser. It is filled in on subsequent sign-in screens; clearing the checkbox deletes the saved ID. Passwords are not stored by this feature.
- Administrators can set **Settings → General settings → Automatic logout** to 1–1440 minutes (24 hours). The default remains 720 minutes (12 hours). Time is counted from login and is not extended by activity.
- Saved changes apply to all users from their next login. Existing sessions retain their original expiry. The server session and login cookie use the same lifetime, with no database schema migration required.

### Password reset (no SMTP required)

- Users select **Forgot your password?** on the sign-in page and enter their registered email. The response is identical regardless of account existence. They contact an administrator to verify their identity and receive a link to choose a new password.
- Administrators check **Users → Password reset requests**, or select **Reset password** for any eligible user without a prior request. Issuing a link requires the administrator's own password. Verify the customer's identity through an established contact before sharing the link; a request alone does not prove identity.
- Links expire after 30 minutes, can be used once, and are invalidated by reissue. Only token hashes are stored; the original link cannot be retrieved after closing the dialog. Issuance is audited.
- Saving a new password invalidates the old password and all sessions. Approval and permissions remain unchanged. Disabled accounts cannot receive a link. Password, email, role and status changes also invalidate outstanding links.
- Signed-in users can use **My account → Change password**. A sole administrator who forgets their password needs a separate operational recovery procedure because no other administrator can approve the request.

Existing PostgreSQL installations must apply this additive migration before restarting the updated server. It adds request and token tables without changing existing accounts, passwords or sessions. Demo storage remains compatible automatically.

```sh
npx tsx scripts/migrate-features.ts 016_password_reset.sql
npx tsx scripts/migrate-features.ts 016_password_reset.sql --apply
```

Follow the existing backup procedure before applying, then create a new backup after adding the schema. Schema compatibility checks may prevent restoring older backups directly. The new tables can remain when rolling the application back. Do not restore users' changed passwords to old values.

| Area                 | Features                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| Overview             | Customer summary, upcoming contract renewals and active tasks                           |
| Companies & contacts | Search, filters, sorting, editing, relationships and contact history                    |
| Activities & tasks   | Calls, meetings, notes, owners, due dates and progress                                  |
| Sales & quotations   | Sales stages, projected revenue, item and discount calculations, approval and printing  |
| Installations        | Installation, access, server and integration details, editing and encrypted attachments |
| Support              | Inquiries, notices, answers, comments, status, attachments and trash                    |
| Settings             | Roles, protected-information masking, menus, products, codes and backup management      |

Editors have the same CRM business permissions as administrators. **Users and roles** and **Settings** are restricted to administrators, including products, codes, the workspace trash and restore actions, and backups. Viewers cannot modify business records. Protected information and downloads remain subject to workspace protection settings.

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

Actual PostgreSQL behavior, external integrations and production deployment need separate verification. Password recovery uses administrator verification and manual link delivery. Email verification, automatic email delivery, SSO, push delivery, external-system access and remote updates are not connected. Scheduled backups run while the application is running; off-site storage and key recovery require separate arrangements.

## Project structure

- `src/`: React screens, client logic and interface translations
- `server/`: API, authentication, permissions, storage, encryption and backups
- `db/`: PostgreSQL schema definitions
- `scripts/`: database provisioning, schema updates, encryption and backup tools
- [LICENSE](LICENSE): Apache-2.0
