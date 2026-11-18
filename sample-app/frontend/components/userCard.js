import { escapeHtml, badge } from '../format.js';

// 本地组件：接收调用方"整包展开透传"过来的对象，
// 自己只挑几个字段用。静态分析必须顺着 spread 跟进来才能算准。
export function renderUserCard(user) {
  const cls = user.highlight ? 'card highlight' : 'card';
  return [
    `<div class="${cls}" data-uid="${escapeHtml(user.id)}">`,
    `  <img class="card-avatar" src="${escapeHtml(user.avatarUrl)}" alt="">`,
    `  <h3>${escapeHtml(user.displayName)} ${badge(user.role, 'role')}</h3>`,
    `  <p class="bio">${escapeHtml(user.bio)}</p>`,
    `  <a class="mail" href="mailto:${escapeHtml(user.email)}">${escapeHtml(user.email)}</a>`,
    `</div>`,
  ].join('\n');
}
