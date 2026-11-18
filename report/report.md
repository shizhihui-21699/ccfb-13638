# 接口过度返回检测报告

> 方法：静态污点分析（解构/展开透传/动态键/权限分支）∪ 运行时 Proxy 追踪（真实流程 + 第三方组件黑盒），取并集判定字段使用；枚举式访问单列，避免展开/序列化造成误判。

## 概览

| 端点 | 返回字段数 | 过度返回(从未使用) | 枚举弱使用 | 未解析动态键 | 外部逃逸调用 |
|---|---|---|---|---|---|
| `/api/users` | 39 | 29 | 0 | 0 | 2 |
| `/api/users/:id` | 39 | 21 | 4 | 0 | 0 |

**结论：共 50 个字段疑似过度返回。**

## 高危发现（P0/P1，共 18 项）

| 级别 | 类别 | 端点 | 字段 | 裁剪置信度 |
|---|---|---|---|---|
| P0 | 凭据/金融/证件 | `/api/users` | `bankCard` | 需复核 |
| P0 | 凭据/金融/证件 | `/api/users/:id` | `bankCard` | 高 |
| P0 | 凭据/金融/证件 | `/api/users` | `idCardNumber` | 需复核 |
| P0 | 凭据/金融/证件 | `/api/users/:id` | `idCardNumber` | 高 |
| P0 | 凭据/金融/证件 | `/api/users` | `passwordHash` | 需复核 |
| P0 | 凭据/金融/证件 | `/api/users/:id` | `passwordHash` | 高 |
| P0 | 凭据/金融/证件 | `/api/users` | `passwordSalt` | 需复核 |
| P0 | 凭据/金融/证件 | `/api/users/:id` | `passwordSalt` | 高 |
| P0 | 凭据/金融/证件 | `/api/users` | `ssn` | 需复核 |
| P0 | 凭据/金融/证件 | `/api/users/:id` | `ssn` | 高 |
| P1 | 直接PII/薪酬 | `/api/users` | `address.detail` | 需复核 |
| P1 | 直接PII/薪酬 | `/api/users/:id` | `address.detail` | 高 |
| P1 | 直接PII/薪酬 | `/api/users` | `address.zip` | 需复核 |
| P1 | 直接PII/薪酬 | `/api/users/:id` | `address.zip` | 高 |
| P1 | 直接PII/薪酬 | `/api/users/:id` | `email` | 高 |
| P1 | 直接PII/薪酬 | `/api/users/:id` | `phone` | 高 |
| P1 | 直接PII/薪酬 | `/api/users` | `salary` | 需复核 |
| P1 | 直接PII/薪酬 | `/api/users/:id` | `salary` | 高 |

## 全部裁剪候选

| 级别 | 端点 | 字段 | 说明 |
|---|---|---|---|
| P0 | `/api/users` | `bankCard` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P0 | `/api/users/:id` | `bankCard` | 静态与运行时均未读取 |
| P0 | `/api/users` | `idCardNumber` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P0 | `/api/users/:id` | `idCardNumber` | 静态与运行时均未读取 |
| P0 | `/api/users` | `passwordHash` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P0 | `/api/users/:id` | `passwordHash` | 静态与运行时均未读取 |
| P0 | `/api/users` | `passwordSalt` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P0 | `/api/users/:id` | `passwordSalt` | 静态与运行时均未读取 |
| P0 | `/api/users` | `ssn` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P0 | `/api/users/:id` | `ssn` | 静态与运行时均未读取 |
| P1 | `/api/users` | `address.detail` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P1 | `/api/users/:id` | `address.detail` | 静态与运行时均未读取 |
| P1 | `/api/users` | `address.zip` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P1 | `/api/users/:id` | `address.zip` | 静态与运行时均未读取 |
| P1 | `/api/users/:id` | `email` | 静态与运行时均未读取 |
| P1 | `/api/users/:id` | `phone` | 静态与运行时均未读取 |
| P1 | `/api/users` | `salary` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P1 | `/api/users/:id` | `salary` | 静态与运行时均未读取 |
| P2 | `/api/users` | `costCenter` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `deletedAt` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `deletedAt` | 静态与运行时均未读取 |
| P2 | `/api/users` | `failedLoginCount` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `flags.beta` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `flags.beta` | 静态与运行时均未读取 |
| P2 | `/api/users` | `flags.suspended` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `flags.suspended` | 静态与运行时均未读取 |
| P2 | `/api/users` | `internalNotes` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `lastLoginAt` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `lastLoginAt` | 静态与运行时均未读取 |
| P2 | `/api/users` | `lastLoginIp` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `loginCount` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `managerId` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `managerId` | 静态与运行时均未读取 |
| P2 | `/api/users` | `riskScore` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users` | `updatedAt` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P2 | `/api/users/:id` | `updatedAt` | 静态与运行时均未读取 |
| P3 | `/api/users` | `address.city` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users` | `address.province` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users/:id` | `avatarUrl` | 静态与运行时均未读取 |
| P3 | `/api/users` | `createdAt` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users/:id` | `id` | 静态与运行时均未读取 |
| P3 | `/api/users` | `preferences.language` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users` | `preferences.notifications.email` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users` | `preferences.notifications.sms` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users` | `preferences.theme` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users/:id` | `role` | 静态与运行时均未读取 |
| P3 | `/api/users` | `social.github` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users` | `social.weibo` | 存在动态键/外部调用，建议人工复核后裁剪 |
| P3 | `/api/users/:id` | `social.weibo` | 静态与运行时均未读取 |
| P3 | `/api/users/:id` | `username` | 静态与运行时均未读取 |

## 逐端点字段明细

### `/api/users`

| 字段 | 级别 | 判定 | 证据 |
|---|---|---|---|
| `address.city` | P3 | 裁剪 | never-read |
| `address.detail` | P1 | 裁剪 | never-read |
| `address.province` | P3 | 裁剪 | never-read |
| `address.zip` | P1 | 裁剪 | never-read |
| `avatarUrl` | P3 | 保留 | static+runtime |
| `bankCard` | P0 | 裁剪 | never-read |
| `bio` | P3 | 保留 | static-only |
| `costCenter` | P2 | 裁剪 | never-read |
| `createdAt` | P3 | 裁剪 | never-read |
| `deletedAt` | P2 | 裁剪 | never-read |
| `department` | P3 | 保留 | static+runtime |
| `displayName` | P3 | 保留 | static+runtime |
| `email` | P1 | 保留 | static+runtime |
| `failedLoginCount` | P2 | 裁剪 | never-read |
| `flags.beta` | P2 | 裁剪 | never-read |
| `flags.suspended` | P2 | 裁剪 | never-read |
| `id` | P3 | 保留 | static-only |
| `idCardNumber` | P0 | 裁剪 | never-read |
| `internalNotes` | P2 | 裁剪 | never-read |
| `lastLoginAt` | P2 | 裁剪 | never-read |
| `lastLoginIp` | P2 | 裁剪 | never-read |
| `loginCount` | P2 | 裁剪 | never-read |
| `managerId` | P2 | 裁剪 | never-read |
| `passwordHash` | P0 | 裁剪 | never-read |
| `passwordSalt` | P0 | 裁剪 | never-read |
| `phone` | P1 | 保留 | static+runtime |
| `preferences.language` | P3 | 裁剪 | never-read |
| `preferences.notifications.email` | P3 | 裁剪 | never-read |
| `preferences.notifications.sms` | P3 | 裁剪 | never-read |
| `preferences.theme` | P3 | 裁剪 | never-read |
| `riskScore` | P2 | 裁剪 | never-read |
| `role` | P3 | 保留 | static-only |
| `salary` | P1 | 裁剪 | never-read |
| `social.github` | P3 | 裁剪 | never-read |
| `social.weibo` | P3 | 裁剪 | never-read |
| `ssn` | P0 | 裁剪 | never-read |
| `title` | P3 | 保留 | static+runtime |
| `updatedAt` | P2 | 裁剪 | never-read |
| `username` | P3 | 保留 | runtime-only |

分析备注：
- 整对象传入外部函数：`(root)`（flows.js）→ 依赖运行时追踪兜底
- 整对象传入外部函数：`(root)`（userListPage.js）→ 依赖运行时追踪兜底
- 展开透传：`(root)`（flows.js）→ 已跟进接收方
- 展开透传：`(root)`（userListPage.js）→ 已跟进接收方

### `/api/users/:id`

| 字段 | 级别 | 判定 | 证据 |
|---|---|---|---|
| `address.city` | P3 | 保留 | static+runtime |
| `address.detail` | P1 | 裁剪 | never-read |
| `address.province` | P3 | 保留 | static+runtime |
| `address.zip` | P1 | 裁剪 | never-read |
| `avatarUrl` | P3 | 裁剪 | never-read |
| `bankCard` | P0 | 裁剪 | never-read |
| `bio` | P3 | 保留 | static+runtime |
| `costCenter` | P2 | 保留 | static-only |
| `createdAt` | P3 | 保留 | static+runtime |
| `deletedAt` | P2 | 裁剪 | never-read |
| `department` | P3 | 保留 | static+runtime |
| `displayName` | P3 | 保留 | static+runtime |
| `email` | P1 | 裁剪 | never-read |
| `failedLoginCount` | P2 | 保留 | static+runtime |
| `flags.beta` | P2 | 裁剪 | never-read |
| `flags.suspended` | P2 | 裁剪 | never-read |
| `id` | P3 | 裁剪 | never-read |
| `idCardNumber` | P0 | 裁剪 | never-read |
| `internalNotes` | P2 | 保留 | static+runtime |
| `lastLoginAt` | P2 | 裁剪 | never-read |
| `lastLoginIp` | P2 | 保留 | static+runtime |
| `loginCount` | P2 | 保留 | static-only |
| `managerId` | P2 | 裁剪 | never-read |
| `passwordHash` | P0 | 裁剪 | never-read |
| `passwordSalt` | P0 | 裁剪 | never-read |
| `phone` | P1 | 裁剪 | never-read |
| `preferences.language` | P3 | 保留(枚举访问,待确认) | enumeration-only |
| `preferences.notifications.email` | P3 | 保留(枚举访问,待确认) | enumeration-only |
| `preferences.notifications.sms` | P3 | 保留(枚举访问,待确认) | enumeration-only |
| `preferences.theme` | P3 | 保留(枚举访问,待确认) | enumeration-only |
| `riskScore` | P2 | 保留 | static+runtime |
| `role` | P3 | 裁剪 | never-read |
| `salary` | P1 | 裁剪 | never-read |
| `social.github` | P3 | 保留 | static+runtime |
| `social.weibo` | P3 | 裁剪 | never-read |
| `ssn` | P0 | 裁剪 | never-read |
| `title` | P3 | 保留 | static+runtime |
| `updatedAt` | P2 | 裁剪 | never-read |
| `username` | P3 | 裁剪 | never-read |

## 覆盖说明

- **只有运行时追踪发现的字段**（动态键/第三方组件内部读取，静态看不到）：`/api/users` → `username`
- **只有静态分析发现的字段**（未执行的权限分支等，运行覆盖不到）：`/api/users` → `bio`、`/api/users` → `id`、`/api/users` → `role`、`/api/users/:id` → `costCenter`、`/api/users/:id` → `loginCount`
- 两类互补：任一方法确认使用的字段都不会进入裁剪候选，以此控制误删风险。
