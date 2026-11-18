// 模拟第三方黑盒组件（比如 npm 包里的头像组件）。
// 静态分析把 vendor/ 目录视为外部代码：它内部读了哪些字段，
// 只能靠运行时追踪发现。
export function avatarBadge(user) {
  const src = user.avatarUrl || '/static/default-avatar.png';
  const alt = user.username;
  return `<img class="avatar" src="${src}" alt="${alt}" width="40" height="40">`;
}
