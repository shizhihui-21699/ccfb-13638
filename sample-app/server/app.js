// 零依赖 HTTP API 服务器。
// 问题现场：/api/users 和 /api/users/:id 都把整条用户记录原样返回。
// 支持加载裁剪方案（trim plan）：加载后按白名单投影字段，用于回归验证。
import http from 'node:http';
import fs from 'node:fs';
import { users, findUser } from './db.js';

// ---------- 深投影：按点分路径白名单裁剪 ----------
// 注意：必须按原记录的键序重建（遍历时以原对象为准），
// 否则裁剪会改变对象键序 —— 前端若有 Object.entries 之类的枚举式渲染，
// 输出顺序就变了，回归能抓到这种"字段没少但顺序变了"的问题。
function buildKeepTree(paths) {
  const root = {};
  for (const p of paths) {
    let node = root;
    for (const k of p.split('.')) node = node[k] ??= {};
  }
  return root;
}

function project(value, tree) {
  // 空子树节点 = 该路径整体保留
  if (tree && typeof tree === 'object' && Object.keys(tree).length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, tree));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (tree[k] !== undefined) out[k] = project(value[k], tree[k]);
    }
    return out;
  }
  return value;
}

export function pickPaths(record, keepPaths) {
  return project(record, buildKeepTree(keepPaths));
}

// ---------- 路由 ----------
const routes = [
  { pattern: '/api/users', match: (p) => p === '/api/users' },
  { pattern: '/api/users/:id', match: (p) => /^\/api\/users\/[^/]+$/.test(p) },
];

function patternOf(pathname) {
  const r = routes.find((r) => r.match(pathname));
  return r ? r.pattern : null;
}

export function createServer({ trimPlan = null } = {}) {
  // trimPlan: { endpoints: { '/api/users': { keep: [...] }, ... } }
  const plan = trimPlan;

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const pattern = patternOf(pathname);

    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    const maybeTrim = (patternKey, data, isArray) => {
      if (!plan || !plan.endpoints || !plan.endpoints[patternKey]) return data;
      const keep = plan.endpoints[patternKey].keep;
      if (isArray) return data.map((rec) => pickPaths(rec, keep));
      return pickPaths(data, keep);
    };

    if (pattern === '/api/users') {
      // 问题现场：整条记录（含 passwordHash / idCardNumber / salary ...）直接返回
      return send(200, maybeTrim(pattern, users, true));
    }
    if (pattern === '/api/users/:id') {
      const id = pathname.split('/').pop();
      const user = findUser(id);
      if (!user) return send(404, { error: 'not found' });
      return send(200, maybeTrim(pattern, user, false));
    }
    if (pathname === '/api/health') return send(200, { ok: true });
    return send(404, { error: 'not found' });
  });
}

// 直接运行：node sample-app/server/app.js [port]
// 加载裁剪方案：TRIM_PLAN=report/trim-plan.json node sample-app/server/app.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  const trimPlan = process.env.TRIM_PLAN
    ? JSON.parse(fs.readFileSync(process.env.TRIM_PLAN, 'utf8'))
    : null;
  const server = createServer({ trimPlan });
  server.listen(port, () => {
    console.log(`[sample-app] listening on http://127.0.0.1:${port} ${trimPlan ? '(trim plan applied)' : '(UNTRIMMED)'}`);
  });
}
