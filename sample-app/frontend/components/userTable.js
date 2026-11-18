import { escapeHtml } from '../format.js';

// 动态键访问的典型：列配置驱动渲染，字段名藏在配置数组里。
const COLUMNS = [
  { key: 'displayName', label: '姓名' },
  { key: 'email', label: '邮箱' },
  { key: 'phone', label: '电话' },
];

export function renderUserTable(users, sortKey) {
  // sortKey 是运行时才确定的参数：a[sortKey] 对静态分析是真·动态键
  const sorted = [...users].sort((a, b) =>
    String(a[sortKey]).localeCompare(String(b[sortKey]))
  );
  const head = COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const rows = sorted
    .map((u) => {
      const cells = COLUMNS.map((c) => `<td>${escapeHtml(u[c.key])}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<table class="user-table">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}
