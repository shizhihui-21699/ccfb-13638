// 字段敏感程度分级。级别含义：
//   P0 致命：凭据、金融账户、政府证件号 —— 泄露即合规事故
//   P1 高：  可直接定位自然人的 PII / 薪酬
//   P2 中：  内部运营数据（风控、登录审计、内部备注、成本中心）
//   P3 低：  正常业务展示字段
const RULES = [
  // 覆盖规则优先：形如 notifications.email 的是"是否邮件通知"的开关，不是邮箱地址
  {
    level: 'P3',
    label: '普通业务字段',
    re: /notifications\.(email|sms|push)$/i,
  },
  {
    level: 'P0',
    label: '凭据/金融/证件',
    re: /password|passwd|pwd|salt|secret|token|credential|session|idcard|bankcard|cardno|ssn|socialsecurity/i,
  },
  {
    level: 'P1',
    label: '直接PII/薪酬',
    re: /phone|mobile|email|salary|income|birth|address\.(detail|zip)$|detail$|zip$/i,
  },
  {
    level: 'P2',
    label: '内部运营数据',
    re: /internal|risk|loginip|logincount|failedlogin|lastlogin|flags|deletedat|notes|costcenter|managerid|updatedat/i,
  },
];

export function gradeField(path) {
  for (const r of RULES) {
    if (r.re.test(path)) return { level: r.level, label: r.label };
  }
  return { level: 'P3', label: '普通业务字段' };
}

export const LEVEL_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
