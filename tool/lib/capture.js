// 起服/跑流程/抓快照的公共助手
import { createServer } from '../../sample-app/server/app.js';

export async function startServer({ trimPlan = null } = {}) {
  const server = createServer({ trimPlan });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 在指定 baseUrl 下跑全部用户流程，返回 { 流程名: 渲染输出 }
export async function runFlows(baseUrl) {
  process.env.APP_BASE_URL = baseUrl;
  const { flows } = await import('../../sample-app/frontend/flows.js');
  const outputs = {};
  for (const [name, fn] of Object.entries(flows)) {
    outputs[name] = await fn();
  }
  return outputs;
}

export async function fetchJson(baseUrl, path) {
  const res = await fetch(baseUrl + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}
