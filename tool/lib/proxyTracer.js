// 运行时字段读取追踪器。
// 把 API 响应包成 Proxy，记录前端代码真实读过的属性路径。
//
// 关键设计：区分"直接读"和"枚举式读"。
//   - `{...user}`、`Object.entries(user)`、`JSON.stringify(user)` 会触发
//     ownKeys + 一连串 get。如果把这些 get 都算作"使用"，展开透传会把
//     所有顶层字段误判为已使用。所以 ownKeys 之后的同一轮 get 记为"枚举读"，
//     被展开拷贝走的值本身仍是子 Proxy —— 接收方组件真正读它时，
//     会在子节点上记为"直接读"。
//   - 最终：direct = 真使用；enum-only = 弱使用（通用渲染/序列化，需人工确认）。

export function createTracer() {
  // 每个 endpoint 一棵读路径树
  const roots = new Map(); // endpoint -> rootNode

  function makeNode(path) {
    return { path, direct: false, enum: false, children: new Map(), proxies: new WeakMap(), enumBurst: null };
  }

  function childNode(parent, key) {
    const p = parent.path ? `${parent.path}.${key}` : key;
    if (!parent.children.has(key)) parent.children.set(key, makeNode(p));
    return parent.children.get(key);
  }

  // 数组元素：所有下标共享一个元素节点，路径与父级相同
  // （/api/users 返回记录数组，字段路径应相对单条记录，不带下标）
  function elementNode(parent) {
    if (!parent.children.has('[]')) parent.children.set('[]', makeNode(parent.path));
    return parent.children.get('[]');
  }

  function wrap(value, node) {
    if (value === null || typeof value !== 'object') return value;
    // 按 (节点, 目标对象) 记忆化：同一节点遇到新对象（如下一条响应）必须包新 Proxy
    if (node.proxies.has(value)) return node.proxies.get(value);

    const handler = {
      get(target, key, receiver) {
        if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
        const val = Reflect.get(target, key, receiver);
        // 方法（数组的 map/filter、对象的 toString 等）：不记录，
        // 绑定到 receiver 上返回，让原生方法内部的迭代继续触达 get 陷阱。
        if (typeof val === 'function') return val.bind(receiver);
        // 数组 length、以及对象上根本不存在的键（如 JSON.stringify 查的 toJSON）：不记录
        if (!(key in target)) return val;
        if (Array.isArray(target) && key === 'length') return val;

        // 数组下标 → 元素节点（不带下标路径）
        if (Array.isArray(target) && /^\d+$/.test(key)) {
          return wrap(val, elementNode(node));
        }

        const child = childNode(node, key);
        if (node.enumBurst && node.enumBurst.has(key)) {
          node.enumBurst.delete(key);
          child.enum = true; // 枚举式读（展开/Object.entries/序列化）
        } else {
          child.direct = true; // 直接读
        }
        return wrap(val, child);
      },
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        node.enumBurst = new Set(keys.filter((k) => typeof k === 'string'));
        return keys;
      },
    };

    const proxy = new Proxy(value, handler);
    node.proxies.set(value, proxy);
    return proxy;
  }

  return {
    // 把一个响应对象纳入追踪；endpoint 是归一化后的路由模式
    track(data, endpoint) {
      if (!roots.has(endpoint)) roots.set(endpoint, makeNode(''));
      return wrap(data, roots.get(endpoint));
    },

    // 汇总：used = 直接读的终端路径；weak = 仅枚举读的终端路径。
    // "终端"很关键：user.address.province 会让 address 也被 get 到，
    // 但那只是路过 —— 只有"直接读且没有更深读取记录"的节点才算真正消费。
    collect() {
      const out = {};
      for (const [endpoint, root] of roots) {
        const used = [];
        const weak = [];
        const walk = (node) => {
          const hasChildReads = node.children.size > 0;
          if (node.path) {
            if (node.direct && !hasChildReads) {
              used.push(node.path); // 终端直读：整个值被消费
            } else if (node.enum && !node.direct && !hasChildReads) {
              weak.push(node.path); // 仅被枚举触达
            }
          }
          for (const c of node.children.values()) walk(c);
        };
        walk(root);
        out[endpoint] = { used: used.sort(), weak: weak.sort() };
      }
      return out;
    },
  };
}

// 把实际 URL（/api/users/u1001）归一化到路由模式（/api/users/:id）
export function normalizePath(pathname, patterns) {
  if (patterns.includes(pathname)) return pathname;
  for (const pat of patterns) {
    const pSegs = pat.split('/');
    const aSegs = pathname.split('/');
    if (pSegs.length !== aSegs.length) continue;
    const ok = pSegs.every((s, i) => s.startsWith(':') || s === aSegs[i]);
    if (ok) return pat;
  }
  return pathname;
}
