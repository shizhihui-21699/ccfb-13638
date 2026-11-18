// 前端 API 客户端。响应拦截器是给运行时追踪器留的钩子：
// 追踪器通过 setResponseInterceptor 把返回数据包成 Proxy，记录真实读路径。
const base = () => process.env.APP_BASE_URL || 'http://127.0.0.1:4173';

let interceptor = null;
export function setResponseInterceptor(fn) {
  interceptor = fn;
}

async function request(path) {
  const res = await fetch(base() + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const data = await res.json();
  return interceptor ? interceptor(data, path) : data;
}

export const apiClient = {
  listUsers: () => request('/api/users'),
  getUser: (id) => request(`/api/users/${id}`),
};
