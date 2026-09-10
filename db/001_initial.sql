-- Proposed application schema. NOT applied automatically by the app or inspection script.
-- Review the target database and dedicated app role before explicitly applying.
-- Does not import or alter public.tb_company or other existing YETA tables.
BEGIN;
CREATE SCHEMA IF NOT EXISTS yeta_crm;
CREATE TABLE yeta_crm.companies (
  id text PRIMARY KEY,
  name varchar(150) NOT NULL CHECK (length(trim(name)) > 0),
  business_number varchar(30) NOT NULL DEFAULT '',
  industry varchar(150) NOT NULL DEFAULT '', ceo varchar(150) NOT NULL DEFAULT '',
  contact_name varchar(150) NOT NULL DEFAULT '', contact_role varchar(150) NOT NULL DEFAULT '',
  email varchar(254) NOT NULL DEFAULT '', phone varchar(40) NOT NULL DEFAULT '', owner varchar(150) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'prospect' CHECK (status IN ('active','prospect','paused')),
  products text[] NOT NULL DEFAULT '{}', employees integer NOT NULL DEFAULT 0 CHECK (employees BETWEEN 0 AND 100000000),
  contract_start date, contract_end date,
  contract_amount bigint NOT NULL DEFAULT 0 CHECK (contract_amount BETWEEN 0 AND 9007199254740991),
  website varchar(500) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  company_code varchar(50) NOT NULL DEFAULT '', corporation_number varchar(50) NOT NULL DEFAULT '',
  company_type varchar(150) NOT NULL DEFAULT '', group_name varchar(150) NOT NULL DEFAULT '', first_contact_date date,
  contact_source varchar(150) NOT NULL DEFAULT '', contact_detail varchar(500) NOT NULL DEFAULT '',
  service_version varchar(20) NOT NULL DEFAULT '' CHECK (service_version IN ('','SAP','On Premises','Cloud')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contract_start IS NULL OR contract_end IS NULL OR contract_end >= contract_start)
);
CREATE TABLE yeta_crm.activities (
  id text PRIMARY KEY, company_id text NOT NULL REFERENCES yeta_crm.companies(id) ON DELETE RESTRICT,
  type varchar(20) NOT NULL CHECK (type IN ('call','email','meeting','note')),
  title varchar(200) NOT NULL CHECK (length(trim(title)) > 0), body text NOT NULL DEFAULT '',
  author varchar(150) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE yeta_crm.tasks (
  id text PRIMARY KEY, title varchar(200) NOT NULL CHECK (length(trim(title)) > 0),
  company_id text REFERENCES yeta_crm.companies(id) ON DELETE RESTRICT, due_date date,
  completed boolean NOT NULL DEFAULT false, priority varchar(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),
  status varchar(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','done')),
  type varchar(20) NOT NULL DEFAULT '개발요청' CHECK (type IN ('개발요청','채권관리','영업관리')),
  owner varchar(150) NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (completed = (status = 'done'))
);
CREATE TABLE yeta_crm.records (
  kind varchar(20) NOT NULL CHECK (kind IN ('contacts','sales','quotations','installations')),
  id text NOT NULL, company_id text NOT NULL REFERENCES yeta_crm.companies(id) ON DELETE RESTRICT,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX companies_status_idx ON yeta_crm.companies(status);
CREATE INDEX companies_owner_idx ON yeta_crm.companies(owner);
CREATE INDEX companies_updated_idx ON yeta_crm.companies(updated_at DESC);
CREATE INDEX companies_renewal_idx ON yeta_crm.companies(contract_end) WHERE status = 'active';
CREATE INDEX companies_products_idx ON yeta_crm.companies USING gin(products);
CREATE INDEX activities_company_created_idx ON yeta_crm.activities(company_id, created_at DESC);
CREATE INDEX tasks_completion_due_idx ON yeta_crm.tasks(completed, due_date);
CREATE INDEX records_company_kind_idx ON yeta_crm.records(company_id, kind);
CREATE INDEX records_kind_updated_idx ON yeta_crm.records(kind, updated_at DESC);
COMMIT;
