// 生成 Markdown 检测报告
import { gradeField, LEVEL_ORDER } from './sensitivity.js';

const VERDICT_LABEL = {
  keep: '保留',
  'keep-review': '保留(枚举访问,待确认)',
  trim: '裁剪',
};

export function renderReport({ merged, staticResult, runtimeResult }) {
  const lines = [];
  lines.push('# 接口过度返回检测报告');
  lines.push('');
  lines.push('> 方法：静态污点分析（解构/展开透传/动态键/权限分支）∪ 运行时 Proxy 追踪（真实流程 + 第三方组件黑盒），取并集判定字段使用；枚举式访问单列，避免展开/序列化造成误判。');
  lines.push('');

  // 概览
  const rows = [];
  let totalTrim = 0;
  const findings = [];
  for (const [ep, data] of Object.entries(merged)) {
    const total = data.fields.length;
    const trim = data.fields.filter((f) => f.verdict === 'trim');
    const review = data.fields.filter((f) => f.verdict === 'keep-review');
    totalTrim += trim.length;
    rows.push(`| \`${ep}\` | ${total} | ${trim.length} | ${review.length} | ${data.notes.dynamicKeys.length} | ${data.notes.externalCalls.length} |`);
    for (const f of trim) {
      const g = gradeField(f.path);
      findings.push({ endpoint: ep, ...f, ...g });
    }
  }
  findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.path.localeCompare(b.path));

  lines.push('## 概览');
  lines.push('');
  lines.push('| 端点 | 返回字段数 | 过度返回(从未使用) | 枚举弱使用 | 未解析动态键 | 外部逃逸调用 |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(...rows);
  lines.push('');
  lines.push(`**结论：共 ${totalTrim} 个字段疑似过度返回。**`);
  lines.push('');

  // 高危发现
  const hot = findings.filter((f) => f.level === 'P0' || f.level === 'P1');
  lines.push(`## 高危发现（P0/P1，共 ${hot.length} 项）`);
  lines.push('');
  if (hot.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 级别 | 类别 | 端点 | 字段 | 裁剪置信度 |');
    lines.push('|---|---|---|---|---|');
    for (const f of hot) {
      lines.push(`| ${f.level} | ${f.label} | \`${f.endpoint}\` | \`${f.path}\` | ${f.confidence === 'high' ? '高' : '需复核'} |`);
    }
  }
  lines.push('');

  // 全部裁剪候选
  lines.push('## 全部裁剪候选');
  lines.push('');
  lines.push('| 级别 | 端点 | 字段 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const f of findings) {
    const note = f.confidence === 'review' ? '存在动态键/外部调用，建议人工复核后裁剪' : '静态与运行时均未读取';
    lines.push(`| ${f.level} | \`${f.endpoint}\` | \`${f.path}\` | ${note} |`);
  }
  lines.push('');

  // 逐端点明细
  lines.push('## 逐端点字段明细');
  for (const [ep, data] of Object.entries(merged)) {
    lines.push('');
    lines.push(`### \`${ep}\``);
    lines.push('');
    lines.push('| 字段 | 级别 | 判定 | 证据 |');
    lines.push('|---|---|---|---|');
    for (const f of data.fields) {
      const g = gradeField(f.path);
      lines.push(`| \`${f.path}\` | ${g.level} | ${VERDICT_LABEL[f.verdict]} | ${f.evidence} |`);
    }
    const n = data.notes;
    if (n.dynamicKeys.length || n.externalCalls.length || n.spreads.length) {
      lines.push('');
      lines.push('分析备注：');
      for (const d of n.dynamicKeys) lines.push(`- 未解析动态键：\`${d.at}\`（${d.file}）`);
      for (const e of n.externalCalls) lines.push(`- 整对象传入外部函数：\`${e.arg}\`（${e.file}）→ 依赖运行时追踪兜底`);
      for (const s of n.spreads) lines.push(`- 展开透传：\`${s.at}\`（${s.file}）→ 已跟进接收方`);
    }
  }
  lines.push('');

  // 方法学脚注
  lines.push('## 覆盖说明');
  lines.push('');
  const runtimeOnly = [];
  const staticOnly = [];
  for (const [ep, data] of Object.entries(merged)) {
    for (const f of data.fields) {
      if (f.evidence === 'runtime-only') runtimeOnly.push(`\`${ep}\` → \`${f.path}\``);
      if (f.evidence === 'static-only') staticOnly.push(`\`${ep}\` → \`${f.path}\``);
    }
  }
  lines.push(`- **只有运行时追踪发现的字段**（动态键/第三方组件内部读取，静态看不到）：${runtimeOnly.length ? runtimeOnly.join('、') : '无'}`);
  lines.push(`- **只有静态分析发现的字段**（未执行的权限分支等，运行覆盖不到）：${staticOnly.length ? staticOnly.join('、') : '无'}`);
  lines.push('- 两类互补：任一方法确认使用的字段都不会进入裁剪候选，以此控制误删风险。');
  lines.push('');
  return lines.join('\n');
}
