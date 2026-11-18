import { apiClient } from '../apiClient.js';
import { escapeHtml, formatDate } from '../format.js';

export async function renderUserDetailPage(id, viewer) {
  const user = await apiClient.getUser(id);
  const parts = [];

  parts.push(`<h1>${escapeHtml(user.displayName)}</h1>`);
  parts.push(`<p class="bio">${escapeHtml(user.bio)}</p>`);
  parts.push(`<div class="org">${escapeHtml(user.department)} / ${escapeHtml(user.title)}</div>`);
  parts.push(`<time>${formatDate(user.createdAt)}</time>`);

  // 嵌套字段：只用省市，不用详细地址和邮编
  parts.push(`<address>${escapeHtml(user.address.province)} ${escapeHtml(user.address.city)}</address>`);

  // 方式5：枚举式通用渲染（Object.entries）——算不算"使用"要单独标注
  const prefs = Object.entries(user.preferences)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`)
    .join('');
  parts.push(`<dl class="prefs">${prefs}</dl>`);

  // 方式6：动态键，键名来自常量列表（只配置了 github，没配 weibo）
  const providers = ['github'];
  for (const p of providers) {
    if (user.social[p]) {
      parts.push(`<a class="social" data-provider="${p}">${escapeHtml(user.social[p])}</a>`);
    }
  }

  // 方式7：只在特定权限分支下才读的字段
  if (viewer.role === 'admin') {
    parts.push(
      `<aside class="admin-panel">风险分 ${user.riskScore}；最近登录 IP ${user.lastLoginIp}` +
      `（失败 ${user.failedLoginCount} 次）<br>内部备注：${escapeHtml(user.internalNotes)}</aside>`
    );
  }
  if (viewer.role === 'auditor') {
    // 注意：回归流程里从不以 auditor 身份运行 —— 这两个字段只有静态分析能看到
    parts.push(`<aside class="audit">登录次数 ${user.loginCount}；成本中心 ${escapeHtml(user.costCenter)}</aside>`);
  }

  return `<!doctype html><html><body>\n${parts.join('\n')}\n</body></html>`;
}
