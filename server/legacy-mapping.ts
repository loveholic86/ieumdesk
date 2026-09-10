// Mapping accepts pg rows (int8 remains text). Original row_to_json text is archived separately.
export type LegacyRow = Record<string, any>;
export type LegacyTables = Record<string, LegacyRow[]>;
export type MappedRow = { table: string; sourceTable: string; sourceKey: string; values: LegacyRow };
export function mapLegacy(tables: LegacyTables, importedAt: string) {
  const rows: MappedRow[] = [];
  const issues: Record<string, number> = {};
  const issue = (key: string) => {
    issues[key] = (issues[key] || 0) + 1;
  };
  const s = (v: unknown) => (v == null ? '' : String(v).trim());
  const text = (v: unknown) => {
    const value = s(v);
    if (
      /(?:password|passwd|비밀번호|비번|패스워드|접속정보|(?:pwd|pw|암호)\s*[:=]|아이디\s*[:=]|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i.test(
        value,
      )
    ) {
      issue('text_preserved_only_in_vault');
      return '[접속정보가 포함될 수 있는 원문은 보안 보관함에 보존됨]';
    }
    return value;
  };
  const bounded = (v: unknown, max: number, kind: string) => {
    const value = text(v);
    if (value.length > max) {
      issue(`${kind}_display_truncated`);
      return value.slice(0, max);
    }
    return value;
  };
  const n = (v: unknown) => {
    const value = Number(v || 0);
    if (!Number.isSafeInteger(value)) throw new Error('LEGACY_UNSAFE_INTEGER');
    return value;
  };
  const date = (v: unknown) => {
    const raw = s(v),
      match = raw.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T].*)?$/);
    if (!raw) return null;
    if (!match) {
      issue('invalid_date_archived');
      return null;
    }
    const value = `${match[1]}-${match[2]}-${match[3]}`;
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== value) {
      issue('invalid_date_archived');
      return null;
    }
    return value;
  };
  const timestamp = (v: unknown) => {
    const raw = s(v);
    if (!raw) return importedAt;
    const d = new Date(raw.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? '' : '+09:00'));
    if (!Number.isFinite(d.valueOf())) {
      issue('invalid_timestamp_archived');
      return importedAt;
    }
    return d.toISOString();
  };
  const code = (group: string, value: unknown, fallback = '') => {
    if (!s(value)) return fallback;
    const entry = tables.code_tb.find((r) => r.grp_cd === group && r.code === value);
    if (!entry) {
      issue(`unknown_${group}`);
      return fallback;
    }
    return s(entry.code_nm);
  };
  const companies = new Map(tables.company_tb.map((r) => [s(r.ct_cd), r]));
  const companyId = (v: unknown, kind: string) => {
    const value = s(v);
    if (companies.has(value)) return `legacy-company-${value}`;
    issue(`${kind}_missing_company`);
    return null;
  };
  const push = (table: string, sourceTable: string, sourceKey: string, values: LegacyRow) =>
    rows.push({ table, sourceTable, sourceKey, values });
  const group = (table: string, key: string) => {
    const result = new Map<string, LegacyRow[]>();
    for (const r of tables[table]) {
      const k = s(r[key]);
      result.set(k, [...(result.get(k) || []), r]);
    }
    return result;
  };
  const managers = group('manager_tb', 'ct_cd');
  const comments = group('manager_comment_tb', 'ct_cd');
  const details = group('quotation_detail_tb', 'qt_id');
  const catalog = new Map(tables.quotation_item_tb.map((r) => [s(r.qt_item_id), r]));
  for (const r of tables.company_tb) {
    const contacts = managers.get(s(r.ct_cd)) || [];
    // No source primary-contact flag: leave representative contact blank instead of guessing.
    push('companies', 'company_tb', s(r.ct_cd), {
      id: `legacy-company-${r.ct_cd}`,
      name: bounded(r.ct_nm, 150, 'company_name') || `이름 없는 기존 고객 ${r.ct_cd}`,
      business_number: bounded(r.com_reg_num, 30, 'business_number'),
      industry: bounded(code('com_cls', r.com_cls), 150, 'industry'),
      ceo: bounded(r.ct_rep, 150, 'ceo'),
      status: 'unclassified',
      address: bounded(r.com_addr, 500, 'address'),
      company_code: s(r.ct_cd),
      corporation_number: bounded(r.corp_reg_num, 50, 'corporation_number'),
      company_type: code('com_type', r.com_type),
      group_name: code('com_group', r.com_group),
      first_contact_date: date(r.contact_dt),
      contact_source: code('contact_cls', r.contact_bcls),
      contact_detail: code('contact_cls', r.contact_mcls),
      note: `기존 CRM 이관. 원본에 현재 계약 상태가 없어 미분류로 보존했습니다. 담당자 ${contacts.length}명은 담당자 메뉴에서 확인할 수 있습니다.`,
      created_at: timestamp(r.cr_dt),
      updated_at: timestamp(r.up_dt || r.cr_dt),
    });
  }
  const record = (
    kind: string,
    r: LegacyRow,
    sourceTable: string,
    key: string,
    company: unknown,
    data: LegacyRow,
    created = r.cr_dt,
    updated = r.up_dt,
  ) =>
    push('records', sourceTable, key, {
      kind,
      id: `legacy-${kind}-${key}`,
      company_id: companyId(company, kind),
      data,
      created_at: timestamp(created),
      updated_at: timestamp(updated || created),
    });
  for (const r of tables.manager_tb)
    record('contacts', r, 'manager_tb', `${r.ct_cd}-${r.mng_cd}`, r.ct_cd, {
      name: bounded(r.mng_nm, 150, 'contact_name') || `이름 없는 담당자 ${r.mng_cd}`,
      department: bounded(r.mng_dept, 150, 'department'),
      role: bounded(r.mng_grd, 150, 'role'),
      type: code('mng_type', r.mng_type, '미분류'),
      phone: bounded(r.tel1, 40, 'phone'),
      mobile: bounded(r.tel2, 40, 'mobile'),
      email: bounded(r.email, 254, 'email'),
      note: bounded(
        [
          s(r.fax) ? `팩스: ${s(r.fax)}` : '',
          s(r.address),
          ...(comments.get(s(r.ct_cd)) || [])
            .filter((c) => s(c.mng_cd) === s(r.mng_cd))
            .map((c) => s(c.contents)),
        ]
          .filter(Boolean)
          .join('\n'),
        10000,
        'contact_note',
      ),
    });
  for (const r of tables.act_tb)
    push('activities', 'act_tb', s(r.act_id), {
      id: `legacy-activity-${r.act_id}`,
      company_id: companyId(r.ct_cd, 'activities'),
      type:
        ({ 미팅: 'meeting', 이메일: 'email', 전화: 'call' } as Record<string, string>)[
          code('act_type', r.act_type)
        ] || 'note',
      title: bounded(r.title, 200, 'activity_title') || `기존 활동 ${r.act_id}`,
      body: bounded(
        [
          `원본 활동유형: ${code('act_type', r.act_type, '미분류')}`,
          s(r.act_dt) ? `원본 활동일: ${s(r.act_dt)}` : '',
          text(r.contents),
        ]
          .filter(Boolean)
          .join('\n'),
        10000,
        'activity_body',
      ),
      author: bounded(r.cr_user_id, 150, 'author') || '기존 CRM',
      created_at: timestamp(r.cr_dt),
    });
  for (const r of tables.task_tb) {
    const status =
      ({ 접수: 'received', 진행중: 'in_progress', 완료: 'done' } as Record<string, string>)[
        code('task_status', r.task_status)
      ] || 'unclassified';
    push('tasks', 'task_tb', s(r.task_id), {
      id: `legacy-task-${r.task_id}`,
      title:
        bounded(
          text(r.contents)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' '),
          170,
          'task_title',
        ) || `기존 할일 ${r.task_id}`,
      company_id: companyId(r.ct_cd, 'tasks'),
      due_date: date(r.en_dt),
      completed: status === 'done',
      priority: 'normal',
      status,
      type: code('task_type', r.task_type, '미분류'),
      owner: bounded(r.task_user_nm || r.task_user_id, 150, 'owner'),
      body: bounded(r.contents, 10000, 'task_body'),
      created_at: timestamp(r.cr_dt),
    });
  }
  const saleTargets = group('sales_target_tb', 'sales_id');
  for (const r of tables.sales_tb) {
    const ids = [...new Set([s(r.ct_cd), ...(saleTargets.get(s(r.sales_id)) || []).map((t) => s(t.ct_cd))])];
    record('sales', r, 'sales_tb', s(r.sales_id), r.ct_cd, {
      name: `${bounded(companies.get(s(r.ct_cd))?.ct_nm, 140, 'sale_company_name')} · 기존 영업 ${r.sales_id}`,
      customerType: code('ct_type', r.ct_type, '신규'),
      stage: code('sales_st', r.sales_st, '타겟고객'),
      serviceVersion: code('sv_version', r.sv_version),
      employees: n(r.sv_num),
      expectedRevenue: n(r.sales_amount),
      owner: bounded(r.cr_user_id, 150, 'owner'),
      note: bounded(r.sales_conts, 10000, 'sales_note'),
      relatedCompanyIds: ids.filter((id) => companies.has(id)).map((id) => `legacy-company-${id}`),
      legacySource: { table: 'sales_tb', key: s(r.sales_id), relatedCompanyCodes: ids },
    });
  }
  for (const r of tables.quotation_tb) {
    const ds = (details.get(s(r.qt_id)) || []).sort((a, b) => n(a.detail_seq) - n(b.detail_seq));
    if (!ds.length) issue('quotation_without_items');
    const itemAmounts: LegacyRow = {};
    const items = ds.map((d, index) => {
      const supply = n(d.tot_amt),
        discount = n(d.dc_amt);
      itemAmounts[String(index)] = {
        subtotal: n(supply + discount),
        discountAmount: discount,
        supplyAmount: supply,
      };
      return {
        name:
          bounded(catalog.get(s(d.qt_item_id))?.qt_item_nm, 200, 'item_name') || `기존 품목 ${d.qt_item_id}`,
        unitPrice: n(d.item_amt),
        quantity: n(d.item_qty),
        months: n(d.item_term || 1),
        discountPercent: d.dc_type === 'P' ? n(d.dc_val) : 0,
      };
    });
    const contact = (managers.get(s(r.ct_cd)) || []).find((m) => s(m.mng_cd) === s(r.mng_cd));
    record('quotations', r, 'quotation_tb', s(r.qt_id), r.ct_cd, {
      number: `OLD-${r.qt_id}`,
      title: bounded(r.qt_desc, 200, 'quote_title'),
      contactName: bounded(contact?.mng_nm, 150, 'quote_contact'),
      issueDate: date(r.qt_dt) || '',
      status: code('qt_st', r.qt_st, '발행'),
      quotationType: code('qt_type', r.qt_type, '미분류'),
      items,
      note: bounded([text(r.qt_desc), text(r.remark)].filter(Boolean).join('\n'), 10000, 'quote_note'),
      subtotal: n(r.tot_amt),
      discount: n(r.dc_amt),
      supplyAmount: n(r.adj_tot_amt),
      vat: n(r.adj_vat_amt),
      total: n(r.issue_amt),
      legacyFinancials: { locked: true, itemAmounts },
      legacySource: { table: 'quotation_tb', key: s(r.qt_id) },
    });
  }
  const setups = group('setup_cominfo_tb', 'setup_cd');
  for (const r of tables.setup_tb) {
    const links = setups.get(s(r.setup_cd)) || [];
    // One installation row per source server; shared-company links remain on that row.
    const valid = links.filter((l) => companies.has(s(l.ct_cd)));
    const primary = valid[0] || links[0];
    const domainRaw = s(r.domainurl);
    let domain = '';
    if (domainRaw) {
      try {
        const url = new URL(/^https?:\/\//i.test(domainRaw) ? domainRaw : `https://${domainRaw}`);
        if (
          !url.username &&
          !url.password &&
          /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(url.hostname)
        )
          domain = url.hostname;
        else issue('installation_domain_vault_only');
      } catch {
        issue('installation_domain_vault_only');
      }
    }
    record('installations', r, 'setup_tb', s(r.setup_cd), primary?.ct_cd, {
      systemCode:
        bounded(
          links
            .map((l) => s(l.sys_cd))
            .filter(Boolean)
            .join(', '),
          80,
          'system_code',
        ) || `OLD-SETUP-${r.setup_cd}`,
      serviceVersion: code('sv_version', r.sv_version),
      version: bounded(r.yeta_version, 80, 'version'),
      installedAt: date(r.setup_date) || '',
      patchedAt: date(r.last_setup_date) || '',
      engineer: bounded(r.setup_engineer, 150, 'engineer'),
      accessType: code('access_type', r.access_type, '알 수 없음'),
      autoUpdate: r.autoupdate_yn === 'Y',
      domain,
      note: `기존 ${s(r.setup_year)}년 설치 정보. 서버·SAP·YETA 접속 계정과 비밀번호 및 상세 설정은 분리된 보안 보관함에 암호화 저장되었습니다.`,
      relatedCompanyIds: [...new Set(valid.map((l) => `legacy-company-${l.ct_cd}`))],
      legacySource: {
        table: 'setup_tb',
        key: s(r.setup_cd),
        year: s(r.setup_year),
        linkedSystemCodes: links.map((l) => s(l.sys_cd)),
      },
    });
  }
  return { rows, issues };
}
