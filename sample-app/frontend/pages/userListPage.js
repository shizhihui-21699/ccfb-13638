import { apiClient } from '../apiClient.js';
import { renderUserCard } from '../components/userCard.js';
import { renderUserTable } from '../components/userTable.js';
import { avatarBadge } from '../vendor/avatarBadge.js';
import { escapeHtml } from '../format.js';

export async function renderUserListPage() {
  const users = await apiClient.listUsers();

  const cards = users
    .map((u, i) => {
      // 方式1：解构
      const { displayName, title, department } = u;
      // 方式2：整包传给第三方黑盒组件（内部偷偷读字段）
      const vendorAvatar = avatarBadge(u);
      // 方式3：展开后整包透传给本地组件
      const card = renderUserCard({ ...u, highlight: i === 0 });
      return [
        `<section class="user-row">`,
        `  ${vendorAvatar}`,
        `  <h2>${escapeHtml(displayName)}</h2>`,
        `  <p class="sub">${escapeHtml(title)} · ${escapeHtml(department)}</p>`,
        `  ${card}`,
        `</section>`,
      ].join('\n');
    })
    .join('\n');

  // 方式4：动态键（列配置 + 运行时排序键）
  const table = renderUserTable(users, 'title');

  return `<!doctype html><html><body>\n<h1>用户列表</h1>\n${cards}\n${table}\n</body></html>`;
}
