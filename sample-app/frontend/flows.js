// 模拟用户操作流程：既用于运行时追踪，也用于回归对比。
// 注意：故意没有 auditor 角色的流程 —— 用来演示"只有静态分析能覆盖的分支"。
import { renderUserListPage } from './pages/userListPage.js';
import { renderUserDetailPage } from './pages/userDetailPage.js';

export const flows = {
  'user-list': () => renderUserListPage(),
  'user-detail-member': () => renderUserDetailPage('u1002', { id: 'u1009', role: 'member' }),
  'user-detail-admin': () => renderUserDetailPage('u1001', { id: 'u1001', role: 'admin' }),
};
