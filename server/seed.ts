import type { Activity, Company, Task, CRMRecordMap, RecordKind, ServiceVersion } from '../src/types.ts';
import { calculateQuotation } from './records.ts';
import { businessDateAfter } from './dates.ts';

export type RecordCollections = { [K in RecordKind]: CRMRecordMap[K][] };
export interface DataSet {
  version: 1;
  companies: Company[];
  activities: Activity[];
  tasks: Task[];
  records?: RecordCollections;
}
const dayOffset = (offset: number) => businessDateAfter(offset);

export function createSeed(): DataSet {
  const names = [
    '오르빗테크',
    '그로브랩',
    '노바웍스',
    '루미에르컴퍼니',
    '코너스튜디오',
    '모먼트솔루션',
    '폴라리스리테일',
    '넥스트브릿지',
    '버드클라우드',
    '디에이치로지스',
    '오픈필드',
    '베리굿파트너스',
    '메이플바이오',
    '플로우디자인',
    '리프에너지',
    '커넥트모빌리티',
  ];
  const industries = [
    'IT·소프트웨어',
    '전문 서비스',
    '제조·생산',
    '유통·커머스',
    '미디어·콘텐츠',
    '교육·연구',
    '바이오·헬스케어',
    '물류·운송',
  ];
  const owners = ['정민서', '이도윤', '김하린'];
  const contacts = ['서예린', '윤지호', '한서윤', '최도현', '문시우', '백하은', '유지안', '강예준'];
  const companies: Company[] = names.map((name, index) => ({
    id: `demo-company-${String(index + 1).padStart(3, '0')}`,
    name,
    businessNumber: '',
    industry: industries[index % industries.length],
    ceo: ['김서진', '이하준', '박지유'][index % 3],
    contactName: contacts[index % contacts.length],
    contactRole: index % 2 === 0 ? '인사팀 매니저' : '경영지원팀 팀장',
    email: `contact${index + 1}@example.com`,
    phone: '',
    owner: owners[index % owners.length],
    status:
      index === 5 || index === 12
        ? 'paused'
        : index === 3 || index === 7 || index === 10
          ? 'prospect'
          : 'active',
    products: ['YETA'],
    employees: [240, 85, 1240, 62, 130, 450, 820, 98][index % 8],
    contractStart: dayOffset(-300 - index * 3),
    contractEnd: dayOffset([16, 120, 23, 180, 215, -40, 90, 240][index % 8]),
    contractAmount: [9600000, 4200000, 28000000, 3600000, 6200000, 16000000, 22000000, 4800000][index % 8],
    website: 'https://example.com',
    address: ['서울특별시 강남구', '서울특별시 성동구', '경기도 성남시 분당구'][index % 3],
    note:
      index === 0
        ? '올해 연말정산 운영 방식 개편을 검토 중입니다. 갱신 미팅에서 서비스 구성과 담당자 교육을 함께 논의해 주세요.'
        : '화면과 업무 흐름 확인을 위한 가상 고객사입니다.',
    updatedAt: new Date(Date.now() - index * 18 * 60 * 60 * 1000).toISOString(),
    companyCode: `DEMO-${String(index + 1).padStart(3, '0')}`,
    corporationNumber: '',
    companyType: '일반기업',
    groupName: '',
    firstContactDate: dayOffset(-400 - index),
    contactSource: index % 2 ? '소개' : '홈페이지 문의',
    contactDetail: '화면 검토용 가상 유입 정보',
    serviceVersion: (['SAP', 'On Premises', 'Cloud'] as ServiceVersion[])[index % 3],
  }));
  const activities: Activity[] = [
    {
      id: 'demo-activity-1',
      companyId: companies[0].id,
      type: 'call',
      title: '계약 갱신 일정 확인',
      body: '담당자와 9월 갱신 미팅 일정을 조율했습니다. 현재 이용 현황과 다음 해 도입 계획을 함께 살펴보기로 했습니다.',
      author: '정민서',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-activity-2',
      companyId: companies[0].id,
      type: 'email',
      title: '서비스 소개서 전달',
      body: 'YETA 서비스 구성과 계약 갱신 절차를 안내하는 소개서를 전달했습니다.',
      author: '정민서',
      createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-activity-3',
      companyId: companies[0].id,
      type: 'meeting',
      title: '상반기 운영 리뷰',
      body: '업무 자동화 만족도를 확인하고 담당자 교육에 대한 의견을 정리했습니다.',
      author: '김하린',
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-activity-4',
      companyId: companies[2].id,
      type: 'note',
      title: '담당자 요청사항',
      body: '신규 입사자 교육 자료 안내가 필요합니다.',
      author: '이도윤',
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    },
  ];
  const tasks: Task[] = [
    {
      id: 'demo-task-1',
      title: '오르빗테크 갱신 제안서 준비',
      companyId: companies[0].id,
      dueDate: dayOffset(0),
      completed: false,
      priority: 'high',
    },
    {
      id: 'demo-task-2',
      title: '노바웍스 담당자 미팅',
      companyId: companies[2].id,
      dueDate: dayOffset(0),
      completed: false,
      priority: 'normal',
    },
    {
      id: 'demo-task-3',
      title: '루미에르컴퍼니 도입 상담 후속 연락',
      companyId: companies[3].id,
      dueDate: dayOffset(1),
      completed: false,
      priority: 'normal',
    },
    {
      id: 'demo-task-4',
      title: '그로브랩 이용 현황 전달',
      companyId: companies[1].id,
      dueDate: dayOffset(2),
      completed: true,
      priority: 'normal',
    },
  ];
  return {
    version: 1,
    companies,
    activities,
    tasks: tasks.map((task, index) => ({
      ...task,
      status: task.completed ? 'done' : index === 0 ? 'in_progress' : 'received',
      type: index === 1 ? '개발요청' : '영업관리',
      owner: owners[index % 3],
      body: '업무 흐름 확인을 위한 가상 할일입니다.',
    })),
    records: createRecordSeed(companies),
  };
}

export function createRecordSeed(companies: Company[]): RecordCollections {
  const records: RecordCollections = { contacts: [], sales: [], quotations: [], installations: [] };
  for (const [index, company] of companies.slice(0, 4).entries()) {
    const updatedAt = company.updatedAt;
    records.contacts.push({
      id: `demo-contact-${company.id}`,
      companyId: company.id,
      title: '',
      updatedAt,
      name: ['서예린', '윤지호', '한서윤', '최도현'][index],
      department: index % 2 ? '경영지원팀' : '인사팀',
      role: index % 2 ? '팀장' : '매니저',
      type: index % 2 ? '전산' : '인사',
      phone: '',
      mobile: '',
      email: `contact${index + 1}@example.com`,
      note: '화면 검토용 합성 담당자입니다.',
    });
    records.sales.push({
      id: `demo-sale-${company.id}`,
      companyId: company.id,
      title: '',
      updatedAt,
      name: `${company.name} YETA ${index % 2 ? '도입 상담' : '계약 갱신'}`,
      customerType: index % 2 ? '신규' : '재계약',
      stage: (['협상', '통신접촉', '대면접촉', '타겟고객'] as const)[index],
      serviceVersion: company.serviceVersion || 'Cloud',
      employees: company.employees,
      expectedRevenue: company.contractAmount,
      owner: company.owner,
      note: '진행 단계와 후속 활동을 확인하는 가상 영업 건입니다.',
    });
    if (index < 2) {
      const items = [
        {
          name: 'YETA 서비스 이용료',
          unitPrice: 500000 + index * 100000,
          quantity: 1,
          months: 12,
          discountPercent: 5,
        },
        { name: '초기 설정 및 교육', unitPrice: 1200000, quantity: 1, months: 1, discountPercent: 0 },
      ];
      records.quotations.push({
        id: `demo-quotation-${company.id}`,
        companyId: company.id,
        title: '',
        updatedAt,
        number: `DEMO-Q-${String(index + 1).padStart(3, '0')}`,
        contactName: company.contactName,
        issueDate: dayOffset(-index),
        status: index === 0 ? '발행' : '승인',
        quotationType: index === 0 ? '재계약' : '신규계약',
        items,
        note: '합성 데이터로 작성한 검토용 견적입니다.',
        ...calculateQuotation(items),
      });
      records.installations.push({
        id: `demo-installation-${company.id}`,
        companyId: company.id,
        title: '',
        updatedAt,
        systemCode: `DEMO-SYS-${index + 1}`,
        serviceVersion: company.serviceVersion || 'Cloud',
        version: '2026.1',
        installedAt: dayOffset(-180),
        patchedAt: dayOffset(-15),
        engineer: ['정민서', '이도윤'][index],
        accessType: index === 0 ? 'VPN/VDI' : '원격',
        autoUpdate: index === 1,
        domain: 'example.com',
        note: '설치 현황만 표시합니다. 비밀번호·계정·IP 등 접속정보는 저장하지 않습니다.',
      });
    }
  }
  return records;
}
