import { trackRequestWork } from './request-limits.ts';
import { Router, type Request, type RequestHandler } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { databaseConfig } from './config.ts';
import { ApiError } from './errors.ts';
import {
  BACKUP_MAX_BYTES,
  privateFile,
  safeDirectory,
  syncDirectory,
  writeExclusive,
} from './backup-files.ts';
import { LegacyReader, legacySensitive } from './legacy-reader.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import type { Store } from './store.ts';
import type { WorkspaceSettingsAccess } from './workspace-settings.ts';
import {
  createInstallationAttachmentStore,
  type InstallationAttachmentStore,
} from './installation-attachments.ts';

type Kind = 'tickets' | 'notices';
type Discussion = {
  id: string;
  title: string;
  body: string;
  author: string;
  authorId?: string;
  createdAt: string;
  canEdit?: boolean;
};
type Attachment = { id: string; name: string; bytes: number; available: boolean };
export type SupportDocument = {
  id: string;
  kind: Kind;
  revision: number;
  title: string;
  body: string;
  companyId: string;
  status: 'received' | 'in_progress' | 'on_hold' | 'answered' | 'closed';
  category: string;
  urgent: boolean;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  assignee: string;
  visible: boolean;
  highlighted: boolean;
  createdAt: string;
  updatedAt: string;
  imported: boolean;
  masked: boolean;
  deleted: boolean;
  answers: Discussion[];
  replies: Discussion[];
  attachments: Attachment[];
  inquireType?: string;
  answerPreference?: string;
  contactMobile?: string;
  mailRequested?: boolean;
  sourceStatusLabel?: string;
};
type Stored = { id: string; revision: number; kind: Kind; envelope: LegacyVaultEnvelope };
type SupportActor = { id: string; name: string; role: string };
type SupportGuard = () => Promise<void | SupportActor>;
const localQueues = new Map<string, Promise<unknown>>();
type Options = {
  directory?: string;
  vault?: () => Promise<LegacyVault>;
  legacy?: Pick<LegacyReader, 'read' | 'companyIds' | 'close'>;
  attachments?: InstallationAttachmentStore;
};
const text = (size = 200) => z.string().trim().max(size);
const storedSchema = z.array(
  z
    .object({
      id: text(200).min(1),
      kind: z.enum(['tickets', 'notices']),
      revision: z.number().int().positive(),
      envelope: z
        .object({
          ciphertext: z.string(),
          nonce: z.string(),
          tag: z.string(),
          keyId: z.string(),
          sha256: z.string(),
        })
        .strict(),
    })
    .strict(),
);
const fields = {
  title: text(300).min(1),
  body: z.string().max(100000),
  companyId: text(200),
  status: z.enum(['received', 'in_progress', 'on_hold', 'answered', 'closed']),
  category: text(120),
  urgent: z.boolean(),
  contactName: text(),
  contactEmail: z.union([z.literal(''), z.email().max(200)]),
  contactPhone: text(),
  assignee: text(120),
  visible: z.boolean(),
  highlighted: z.boolean(),
  inquireType: text(),
  answerPreference: text(),
  contactMobile: text(),
  mailRequested: z.boolean(),
};
const createSchema = z
  .object({
    kind: z.enum(['tickets', 'notices']),
    ...fields,
    body: fields.body.min(1),
    companyId: fields.companyId.default(''),
    status: fields.status.default('received'),
    category: fields.category.default(''),
    urgent: fields.urgent.default(false),
    contactName: fields.contactName.default(''),
    contactEmail: fields.contactEmail.default(''),
    contactPhone: fields.contactPhone.default(''),
    assignee: fields.assignee.default(''),
    visible: fields.visible.default(true),
    highlighted: fields.highlighted.default(false),
    inquireType: fields.inquireType.default(''),
    answerPreference: fields.answerPreference.default(''),
    contactMobile: fields.contactMobile.default(''),
    mailRequested: fields.mailRequested.default(false),
  })
  .strict();
const patchSchema = z
  .object({
    ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.optional()])),
    revision: z.number().int().min(0),
  })
  .strict();
const conflict = () =>
  new ApiError(409, 'SUPPORT_CONFLICT', '고객지원 자료가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.');
const missing = () => new ApiError(404, 'NOT_FOUND', '고객지원 자료를 찾을 수 없습니다.');
const scalar = (value: unknown) => (value == null ? '' : String(value));
const flag = (value: unknown) => ['Y', 'y', '1', 'true'].includes(scalar(value));
const idFor = (kind: string, key: string) =>
  `support-${createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 32)}`;
const date = (value: unknown) => {
  const raw = scalar(value);
  if (!raw) return '';
  const parsed = new Date(raw.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? '' : '+09:00'));
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : '';
};
const aad = (id: string) => ({
  source: 'yeta-crm-support:v1',
  table: 'support_items',
  primaryKey: id,
  batchId: id,
});
export class SupportService {
  private legacy: Pick<LegacyReader, 'read' | 'companyIds' | 'close'>;
  readonly attachments: InstallationAttachmentStore;
  private directory: string;
  private pool?: Promise<pg.Pool>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private options: Options = {},
  ) {
    this.legacy = options.legacy ?? new LegacyReader(store.mode);
    this.directory = path.resolve(options.directory ?? '.local/support');
    this.attachments =
      options.attachments ??
      createInstallationAttachmentStore({
        directory: path.resolve('.local/support-attachments'),
        vault: options.vault,
      });
  }
  private vault() {
    return (this.options.vault ?? (() => openLegacyVault({ createIfMissing: false })))();
  }
  private async connection() {
    return (this.pool ??= (async () => {
      const pool = new pg.Pool({ ...(await databaseConfig()), max: 2, allowExitOnIdle: true });
      pool.on('error', () => {});
      try {
        if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== 'yeta_crm')
          throw new Error();
        return pool;
      } catch {
        await pool.end();
        throw new ApiError(503, 'SUPPORT_UNAVAILABLE', '고객지원 저장소를 확인하지 못했습니다.');
      }
    })().catch((error) => {
      this.pool = undefined;
      throw error;
    }));
  }
  private async stored(): Promise<Stored[]> {
    if (this.store.mode === 'postgres')
      return (
        await (
          await this.connection()
        ).query('SELECT id,kind,revision,envelope FROM yeta_crm_private.support_items')
      ).rows;
    let content: Buffer | undefined;
    try {
      if (!(await this.privateDirectory(false))) return [];
      content = await privateFile(path.join(this.directory, 'items.json'), BACKUP_MAX_BYTES);
      return storedSchema.parse(JSON.parse(content.toString('utf8')));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw new ApiError(503, 'SUPPORT_UNAVAILABLE', '고객지원 저장소를 확인하지 못했습니다.');
    } finally {
      content?.fill(0);
    }
  }
  private async privateDirectory(create: boolean) {
    // Check the controlled parent before resolving any child; never follow its symlink.
    if (!(await safeDirectory(path.dirname(this.directory), create))) return false;
    if (!(await safeDirectory(this.directory, create))) return false;
    if (((await lstat(this.directory)).mode & 0o7777) !== 0o700)
      throw new ApiError(503, 'SUPPORT_UNAVAILABLE', '고객지원 저장소를 확인하지 못했습니다.');
    return true;
  }
  private async original(): Promise<SupportDocument[]> {
    const [rows, companies] = await Promise.all([
      this.legacy.read([
        'cs_qna_tb',
        'cs_notice_tb',
        'cs_answer_tb',
        'cs_reply_tb',
        'cs_addfile_tb',
        'code_tb',
      ]),
      this.legacy.companyIds(),
    ]);
    const codes = new Map(
      rows
        .filter((row) => row.table === 'code_tb')
        .map((row) => [`${scalar(row.data.grp_cd)}\0${scalar(row.data.code)}`, scalar(row.data.code_nm)]),
    );
    const label = (group: string, value: unknown) => codes.get(`${group}\0${scalar(value)}`) ?? scalar(value);
    const result: SupportDocument[] = [];
    const answersByQna = new Map<string, Discussion[]>(),
      repliesByQna = new Map<string, Discussion[]>(),
      answerParents = new Map<string, string>();
    for (const row of rows) {
      const data = row.data;
      if (row.table === 'cs_answer_tb' || row.table === 'cs_reply_tb') {
        const answer = row.table === 'cs_answer_tb',
          key = scalar(data.qna_id),
          target = answer ? answersByQna : repliesByQna;
        const item: Discussion = {
          id: idFor(answer ? 'answer' : 'reply', row.key),
          title: answer ? scalar(data.answer_title) : '',
          body: scalar(answer ? data.answer_content : data.reply_content),
          author: '기존 CRM',
          createdAt: date(data.cr_dt),
        };
        target.set(key, [...(target.get(key) ?? []), item]);
        if (answer) answerParents.set(scalar(data.answer_id), key);
      }
    }
    const sourceFiles = new Map<string, Attachment[]>();
    for (const row of rows.filter((row) => row.table === 'cs_addfile_tb')) {
      const raw = scalar(row.data.text_type),
        type = label('text_type', raw).toLowerCase();
      let kind = '';
      let key = scalar(row.data.text_id);
      if (['filebd_qna', 'qna', 'question', 'cs_qna', 'cs_qna_tb', '문의', '질문'].includes(type))
        kind = 'tickets';
      else if (['filebd_notice', 'notice', 'cs_notice', 'cs_notice_tb', '공지', '공지사항'].includes(type))
        kind = 'notices';
      else if (['filebd_answer', 'answer', 'cs_answer', 'cs_answer_tb', '답변'].includes(type)) {
        kind = 'tickets';
        key = answerParents.get(key) ?? '';
      }
      if (!kind || !key) continue; // An unknown attachment type must never be guessed across records.
      const target = idFor(kind, key),
        item = {
          id: idFor('file', row.key),
          name: scalar(row.data.filename || row.data.real_filename),
          bytes: 0,
          available: false,
        };
      sourceFiles.set(target, [...(sourceFiles.get(target) ?? []), item]);
    }
    for (const row of rows) {
      if (!['cs_qna_tb', 'cs_notice_tb'].includes(row.table)) continue;
      const data = row.data;
      const kind: Kind = row.table === 'cs_qna_tb' ? 'tickets' : 'notices';
      const key = scalar(kind === 'tickets' ? data.qna_id : data.notice_id),
        id = idFor(kind, key);
      const originalStatus = label('qna_status_type', data.qna_status_type);
      const status: SupportDocument['status'] = /답변.*완료|답변등록/.test(originalStatus)
        ? 'answered'
        : /종료|처리완료|완료|해결/.test(originalStatus)
          ? 'closed'
          : /보류/.test(originalStatus)
            ? 'on_hold'
            : /진행|처리중|접수|검토/.test(originalStatus)
              ? 'in_progress'
              : 'received';
      result.push({
        id,
        kind,
        revision: 0,
        title: scalar(kind === 'tickets' ? data.qna_title : data.notice_title),
        body: scalar(kind === 'tickets' ? data.qna_content : data.notice_content),
        companyId: companies.get(scalar(data.ct_cd)) ?? '',
        status,
        sourceStatusLabel: originalStatus,
        category: label(
          kind === 'tickets' ? 'category_type' : 'notice_type',
          kind === 'tickets' ? data.qna_category_type : data.notice_type,
        ),
        urgent: flag(data.urgent_yn),
        contactName: scalar(data.cs_customer_nm),
        contactEmail: scalar(data.cs_customer_email),
        contactPhone: scalar(data.cs_customer_tel),
        contactMobile: scalar(data.cs_customer_phone),
        assignee: data.cs_manager_id ? '기존 담당자' : '',
        visible: kind === 'tickets' || flag(data.show_yn),
        highlighted: flag(data.highlight_yn),
        createdAt: date(data.cr_dt),
        updatedAt: date(data.up_dt || data.cr_dt),
        imported: true,
        masked: false,
        deleted: flag(data.del_yn),
        answers: kind === 'tickets' ? (answersByQna.get(key) ?? []) : [],
        replies: kind === 'tickets' ? (repliesByQna.get(key) ?? []) : [],
        attachments: sourceFiles.get(id) ?? [],
        inquireType: label('inquire_type', data.qna_inquire_type),
        answerPreference: label('hope_answer_type', data.hope_answer_type),
        mailRequested: flag(data.sendmail_yn),
      });
    }
    return result;
  }
  async all(): Promise<SupportDocument[]> {
    const [original, edits] = await Promise.all([this.original(), this.stored()]);
    const items = new Map(original.map((item) => [item.id, item]));
    if (edits.length) {
      const vault = await this.vault();
      for (const item of edits) {
        const doc = JSON.parse(vault.decrypt(item.envelope, aad(item.id))) as SupportDocument;
        if (doc.id !== item.id || doc.revision !== item.revision || doc.kind !== item.kind)
          throw new ApiError(503, 'SUPPORT_UNAVAILABLE', '고객지원 자료를 확인하지 못했습니다.');
        items.set(doc.id, doc);
      }
    }
    return [...items.values()].sort(
      (a, b) =>
        (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt) || a.id.localeCompare(b.id),
    );
  }
  async get(id: string, includeArchived = false) {
    const item = (await this.all()).find((row) => row.id === id);
    if (!item || (!includeArchived && item.deleted)) throw missing();
    return item;
  }
  async detail(id: string, includeArchived = false) {
    const item = await this.get(id, includeArchived);
    const files = await this.attachments.list(`support:${id}`);
    return {
      ...item,
      attachments: [
        ...item.attachments.filter((file) => !file.available),
        ...files.map((file) => ({ id: file.id, name: file.name, bytes: file.size, available: true })),
      ],
    };
  }
  async countCompany(companyId: string) {
    return (await this.all()).filter((item) => item.companyId === companyId && !item.deleted).length;
  }
  private async save(
    next: SupportDocument,
    expectedRevision: number,
    actor: SupportActor,
    guard: SupportGuard,
    adminOnly = false,
  ) {
    const actorId = actor.id;
    const assertCurrent = async () => {
      const live = await guard();
      if (live) {
        if (live.id !== actorId)
          throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '현재 계정을 확인해 주세요.');
        actor = live;
      }
      if (!['admin', 'editor'].includes(actor.role))
        throw new ApiError(403, 'WRITE_PERMISSION_REQUIRED', '등록·수정 권한이 필요합니다.');
      if ((next.deleted || adminOnly) && actor.role !== 'admin')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    };
    await assertCurrent();
    if (next.companyId && !next.deleted) await this.store.getCompany(next.companyId);
    next = {
      ...next,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
      masked: false,
      attachments: next.attachments.filter((file) => !file.available),
    };
    const vault = await this.vault(),
      envelope = vault.encrypt(JSON.stringify(next), aad(next.id));
    await assertCurrent();
    const entry = { id: next.id, kind: next.kind, revision: next.revision, envelope };
    if (this.store.mode === 'demo') {
      const pending = (localQueues.get(this.directory) ?? Promise.resolve()).then(async () => {
        const values = await this.stored();
        const old = values.find((row) => row.id === next.id);
        if ((old?.revision ?? 0) !== expectedRevision) throw conflict();
        await assertCurrent();
        if (next.companyId && !next.deleted) await this.store.getCompany(next.companyId);
        await this.privateDirectory(true);
        const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
        try {
          await writeExclusive(
            temporary,
            JSON.stringify([...values.filter((row) => row.id !== next.id), entry]),
          );
          await rename(temporary, path.join(this.directory, 'items.json'));
          await syncDirectory(this.directory);
        } finally {
          await unlink(temporary).catch(() => {});
        }
        return next;
      });
      this.queue = pending.catch(() => {});
      localQueues.set(this.directory, this.queue);
      const settled = this.queue;
      void settled.then(() => {
        if (localQueues.get(this.directory) === settled) localQueues.delete(this.directory);
      });
      return pending;
    }
    const client = await (await this.connection()).connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [actor.id])
      ).rows[0];
      if (!current || current.status !== 'active' || !['admin', 'editor'].includes(current.role))
        throw new ApiError(403, 'WRITE_PERMISSION_REQUIRED', '등록·수정 권한이 필요합니다.');
      if ((next.deleted || adminOnly) && current.role !== 'admin')
        throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
      const saved = await client.query(
        expectedRevision === 0
          ? `INSERT INTO yeta_crm_private.support_items(id,kind,revision,envelope,company_id,archived_at,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,envelope=EXCLUDED.envelope,company_id=EXCLUDED.company_id,archived_at=EXCLUDED.archived_at,updated_by=EXCLUDED.updated_by,updated_at=now() WHERE support_items.revision=$8 RETURNING id`
          : `UPDATE yeta_crm_private.support_items SET revision=$3,envelope=$4::jsonb,company_id=$5,archived_at=$6,updated_by=$7,updated_at=now() WHERE id=$1 AND kind=$2 AND revision=$8 RETURNING id`,
        [
          next.id,
          next.kind,
          next.revision,
          JSON.stringify(envelope),
          next.companyId || null,
          next.deleted ? new Date() : null,
          actor.id,
          expectedRevision,
        ],
      );
      if (saved.rowCount !== 1) throw conflict();
      await client.query(
        "INSERT INTO yeta_crm.workspace_audit(actor_id,action,area,result) VALUES($1,'고객지원 변경','support','완료')",
        [actor.id],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async create(body: unknown, actor: SupportActor, guard: SupportGuard) {
    const input = createSchema.parse(body);
    const now = new Date().toISOString();
    return this.save(
      {
        ...input,
        id: randomUUID(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        imported: false,
        masked: false,
        deleted: false,
        answers: [],
        replies: [],
        attachments: [],
      },
      0,
      actor,
      guard,
    );
  }
  async patch(id: string, body: unknown, actor: SupportActor, guard: SupportGuard) {
    const input = patchSchema.parse(body) as { revision: number; [key: string]: unknown };
    const previous = await this.get(id);
    if (previous.revision !== input.revision) throw conflict();
    const next = { ...previous, ...input } as SupportDocument;
    return this.save(next, input.revision, actor, guard);
  }
  async discussion(
    id: string,
    kind: 'answers' | 'replies',
    body: unknown,
    actor: SupportActor,
    guard: SupportGuard,
  ) {
    const input = z
      .object({ title: text(300).optional(), body: z.string().min(1).max(100000) })
      .strict()
      .parse(body);
    const previous = await this.get(id);
    const entry = {
      id: randomUUID(),
      title: input.title ?? '',
      body: input.body,
      author: actor.name,
      authorId: actor.id,
      createdAt: new Date().toISOString(),
    };
    const next = {
      ...previous,
      [kind]: [...previous[kind], entry],
      ...(kind === 'answers' ? { status: 'answered' as const } : {}),
    };
    return this.save(next, previous.revision, actor, guard);
  }
  async editDiscussion(
    id: string,
    kind: 'answers' | 'replies',
    entryId: string,
    body: unknown,
    remove: boolean,
    actor: SupportActor,
    guard: SupportGuard,
  ) {
    const input = z
      .object({
        revision: z.number().int().min(0),
        ...(remove ? {} : { title: text(300).optional(), body: z.string().min(1).max(100000) }),
      })
      .strict()
      .parse(body) as { revision: number; title?: string; body?: string };
    const previous = await this.get(id);
    if (previous.revision !== input.revision) throw conflict();
    const entry = previous[kind].find((row) => row.id === entryId);
    if (!entry) throw missing();
    const permitted = () => {
      if (actor.role !== 'admin' && (!entry.authorId || entry.authorId !== actor.id))
        throw new ApiError(403, 'DISCUSSION_PERMISSION_REQUIRED', '작성자 또는 관리자가 수정할 수 있습니다.');
    };
    permitted();
    const next = {
      ...previous,
      [kind]: remove
        ? previous[kind].filter((row) => row.id !== entryId)
        : previous[kind].map((row) =>
            row.id === entryId ? { ...row, body: input.body!, title: input.title ?? row.title } : row,
          ),
    };
    return this.save(
      next,
      input.revision,
      actor,
      async () => {
        const live = await guard();
        if (live) {
          if (live.id !== actor.id)
            throw new ApiError(401, 'AUTHENTICATION_REQUIRED', '현재 계정을 확인해 주세요.');
          actor = live;
        }
        permitted();
        return live;
      },
      entry.authorId !== actor.id,
    );
  }
  async archive(id: string, body: unknown, deleted: boolean, actor: SupportActor, guard: SupportGuard) {
    const input = z
      .object({ revision: z.number().int().min(0) })
      .strict()
      .parse(body);
    const previous = await this.get(id, true);
    if (previous.revision !== input.revision) throw conflict();
    return this.save({ ...previous, deleted }, input.revision, actor, guard, true);
  }
  async close() {
    await this.queue;
    await this.legacy.close();
    if (this.pool) await (await this.pool).end();
  }
}
export function protectSupport(item: SupportDocument, enabled: boolean): SupportDocument {
  const protectedContent = [
    item.title,
    item.body,
    item.contactName,
    item.contactEmail,
    item.contactPhone,
    item.contactMobile ?? '',
    ...item.answers.flatMap((row) => [row.title, row.body]),
    ...item.replies.flatMap((row) => [row.title, row.body]),
  ].some(legacySensitive);
  const masked = enabled && protectedContent;
  return {
    ...item,
    title: enabled && legacySensitive(item.title) ? '보호됨' : item.title,
    masked,
    body: masked ? '보호됨' : item.body,
    contactName: masked ? '보호됨' : item.contactName,
    contactEmail: masked ? '보호됨' : item.contactEmail,
    contactPhone: masked ? '보호됨' : item.contactPhone,
    contactMobile: masked ? '보호됨' : item.contactMobile,
    answers: item.answers.map(({ authorId: _authorId, ...row }) => ({
      ...row,
      title: masked ? '보호됨' : row.title,
      body: masked ? '보호됨' : row.body,
    })),
    replies: item.replies.map(({ authorId: _authorId, ...row }) => ({
      ...row,
      title: masked ? '보호됨' : row.title,
      body: masked ? '보호됨' : row.body,
    })),
  };
}
export function createSupportRouter(
  service: SupportService,
  workspace: WorkspaceSettingsAccess,
  requireAdmin: RequestHandler,
  requireEditor: RequestHandler,
  assertActive: (request: Request) => Promise<void>,
) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  const actor = (request: Request) => request.authUser!;
  const writeGuard = (request: Request) => async () => {
    await assertActive(request);
    if (!['admin', 'editor'].includes(actor(request).role))
      throw new ApiError(403, 'WRITE_PERMISSION_REQUIRED', '등록·수정 권한이 필요합니다.');
    return actor(request);
  };
  const adminGuard = (request: Request) => async () => {
    await assertActive(request);
    if (actor(request).role !== 'admin')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    return actor(request);
  };
  const authorized = (request: Request, doc: SupportDocument) => {
    if (
      (doc.deleted && actor(request).role !== 'admin') ||
      (doc.kind === 'notices' && !doc.visible && actor(request).role === 'viewer')
    )
      throw missing();
  };
  const visible = async (request: Request, id: string) => {
    const doc = await service.detail(id, actor(request).role === 'admin');
    await assertActive(request);
    authorized(request, doc);
    return doc;
  };
  const disclosurePolicy = async (request: Request) => {
    await assertActive(request);
    let enabled = (await workspace.get()).protectionEnabled;
    await assertActive(request);
    enabled ||= actor(request).role !== 'admin';
    if (!enabled) {
      try {
        await workspace.audit({
          actorId: actor(request).id,
          action: '보호 정보 조회',
          area: 'support',
          result: '완료',
        });
      } catch {
        throw new ApiError(
          503,
          'SUPPORT_DISCLOSURE_AUDIT_UNAVAILABLE',
          '보호정보 조회 기록을 저장하지 못해 정보를 표시할 수 없습니다.',
        );
      }
      enabled = (await workspace.get()).protectionEnabled;
    }
    await assertActive(request);
    return enabled || actor(request).role !== 'admin';
  };
  const prepare = async (request: Request, doc: SupportDocument) => {
    authorized(request, doc);
    const enabled = await disclosurePolicy(request);
    authorized(request, doc);
    const result = protectSupport(doc, enabled);
    for (const kind of ['answers', 'replies'] as const)
      result[kind] = result[kind].map((row, index) => ({
        ...row,
        canEdit:
          ['admin', 'editor'].includes(actor(request).role) &&
          (actor(request).role === 'admin' || doc[kind][index].authorId === actor(request).id),
      }));
    return result;
  };
  const send = async (request: Request, response: import('express').Response, id: string) =>
    response.json(await prepare(request, await visible(request, id)));
  const downloadAllowed = async (request: Request) => {
    await adminGuard(request)();
    const enabled = (await workspace.get()).protectionEnabled;
    await adminGuard(request)();
    if (enabled)
      throw new ApiError(
        403,
        'SUPPORT_PROTECTION_ENABLED',
        '환경설정에서 보호정보를 비활성화한 뒤 파일을 내려받을 수 있습니다.',
      );
  };
  router.get('/', trackRequestWork(async (request, response) => {
    const query = z
      .object({
        kind: z.enum(['tickets', 'notices']).default('tickets'),
        search: text(200).default(''),
        status: z.enum(['', 'received', 'in_progress', 'on_hold', 'answered', 'closed']).default(''),
        includeArchived: z.enum(['true', 'false']).default('false'),
      })
      .parse(request.query);
    if (query.includeArchived === 'true' && actor(request).role !== 'admin')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    const source = await service.all();
    const policy = await disclosurePolicy(request);
    if (query.includeArchived === 'true' && actor(request).role !== 'admin')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    const items = source
      .map((item) => protectSupport(item, policy))
      .filter(
        (item) =>
          item.kind === query.kind &&
          (query.includeArchived === 'true' || !item.deleted) &&
          (actor(request).role !== 'viewer' || item.kind !== 'notices' || item.visible) &&
          (!query.status || item.status === query.status) &&
          (!query.search ||
            `${item.title} ${item.body} ${item.category} ${item.contactName}`
              .toLocaleLowerCase()
              .includes(query.search.toLocaleLowerCase())),
      )
      .map((item) => ({ ...item, body: '', answers: [], replies: [], attachments: [] }));
    response.json({ items });
  }));
  router.get('/:id', trackRequestWork(async (request, response) => send(request, response, String(request.params.id))));
  router.post('/', requireEditor, trackRequestWork(async (request, response) => {
    const doc = await service.create(request.body, actor(request), writeGuard(request));
    await send(request, response.status(201), doc.id);
  }));
  router.patch('/:id', requireEditor, trackRequestWork(async (request, response) => {
    const doc = await service.patch(
      String(request.params.id),
      request.body,
      actor(request),
      writeGuard(request),
    );
    await send(request, response, doc.id);
  }));
  for (const kind of ['answers', 'replies'] as const)
    router.post(`/:id/${kind}`, requireEditor, trackRequestWork(async (request, response) => {
      const doc = await service.discussion(
        String(request.params.id),
        kind,
        request.body,
        actor(request),
        writeGuard(request),
      );
      await send(request, response.status(201), doc.id);
    }));
  for (const kind of ['answers', 'replies'] as const)
    for (const method of ['patch', 'delete'] as const)
      router[method](`/:id/${kind}/:entryId`, requireEditor, trackRequestWork(async (request, response) => {
        const doc = await service.editDiscussion(
          String(request.params.id),
          kind,
          String(request.params.entryId),
          request.body,
          method === 'delete',
          actor(request),
          writeGuard(request),
        );
        await send(request, response, doc.id);
      }));
  for (const [operation, deleted] of [
    ['archive', true],
    ['restore', false],
  ] as const)
    router.post(`/:id/${operation}`, requireAdmin, trackRequestWork(async (request, response) => {
      const doc = await service.archive(
        String(request.params.id),
        request.body,
        deleted,
        actor(request),
        adminGuard(request),
      );
      await send(request, response, doc.id);
    }));
  router.post('/:id/attachments', requireEditor, trackRequestWork(async (request, response) => {
    const id = String(request.params.id);
    await service.get(id);
    const input = z.object({ name: z.string(), contentBase64: z.string() }).strict().parse(request.body);
    try {
      await service.attachments.upload(`support:${id}`, input, async () => {
        await writeGuard(request)();
        await service.get(id);
        await writeGuard(request)();
      });
      await send(request, response.status(201), id);
    } finally {
      request.body = undefined;
    }
  }));
  router.delete('/:id/attachments/:fileId', requireEditor, trackRequestWork(async (request, response) => {
    const id = String(request.params.id);
    await service.get(id);
    await service.attachments.remove(`support:${id}`, String(request.params.fileId), async () => {
      await writeGuard(request)();
      await service.get(id);
      await writeGuard(request)();
    });
    response.status(204).end();
  }));
  router.get('/:id/attachments/:fileId/download', trackRequestWork(async (request, response) => {
    await downloadAllowed(request);
    const id = String(request.params.id);
    await visible(request, id);
    const file = await service.attachments.download(`support:${id}`, String(request.params.fileId));
    try {
      await assertActive(request);
      await workspace.audit({
        actorId: actor(request).id,
        action: '첨부 다운로드',
        area: 'support',
        result: '완료',
      });
      await assertActive(request);
      await visible(request, id);
      await downloadAllowed(request);
      if (response.destroyed || response.writableEnded) {
        file.content.fill(0);
        return;
      }
      response.attachment(file.name).type(file.mime);
      response.once('finish', () => file.content.fill(0));
      response.once('close', () => file.content.fill(0));
      response.send(file.content);
    } catch (error) {
      file.content.fill(0);
      throw error;
    }
  }));
  return router;
}
