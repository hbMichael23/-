# Supabase 初始化

本文从零配置知隙所需的后端。按顺序执行，**不要跳过 RLS 与 Storage 部分**。

> 你需要准备：一个 Supabase 项目、Supabase CLI（推荐）、一个可用的短信服务商。  
> 微信 / QQ 的 OAuth 额外配置见 [OAUTH_WECHAT_QQ.md](OAUTH_WECHAT_QQ.md)。

---

## 1. 创建项目

1. 打开 [supabase.com](https://supabase.com/dashboard)，新建项目。
2. 区域建议选 **Southeast Asia (Singapore)** 或离你的用户更近的区域，国内访问通常比美区稳定。
3. 保存：
   - Project URL：`https://xxxx.supabase.co`
   - `anon` public key
   - `service_role` secret（**只用于服务端，绝不进入前端**）
4. 项目创建完成后，在 **Project Settings → API** 确认上述值。
5. 确认 **Project Settings → API → Exposed schemas** 包含 `public`（新项目默认包含；自托管项目需手动启用 Data API / PostgREST）。
6. 确认 **Realtime** 在项目设置中启用（新项目默认启用）。

---

## 2. 执行数据库迁移

迁移文件：

```text
supabase/migrations/20261112000000_init.sql
```

### 方式 A：Supabase CLI（推荐）

```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

`YOUR_PROJECT_REF` 是项目 URL 中 `xxxx.supabase.co` 的 `xxxx`。  
如果 CLI 提示远端已有 migration 历史，先在测试项目验证，再决定是否 `supabase db reset`。

### 方式 B：Dashboard SQL Editor

打开 **SQL Editor → New query**，完整粘贴迁移文件并执行。  
迁移是幂等的（使用 `if not exists` / `drop policy if exists`），但仍建议先在空项目执行。

### 迁移做了什么

| 对象 | 作用 |
| --- | --- |
| `public.profiles` | 用户资料，注册 trigger 自动创建 |
| `public.user_settings` | 标签、提醒设置，每用户一行 |
| `public.questions` | 错题、复习状态、复习历史，`(user_id, id)` 复合主键 |
| `public.oauth_identities` | 微信/QQ uid → Supabase user 映射 |
| `public.oauth_states` | OAuth state 防 CSRF，10 分钟过期 |
| `storage.buckets.question-images` | 私有图片桶，5 MB 限制，jpeg/png/webp |
| RLS policies | 所有表、Storage 对象按 `auth.uid()` 隔离 |
| Realtime publication | `questions`、`user_settings` 加入实时订阅 |

### 验证表和 RLS

在 SQL Editor 执行：

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles', 'user_settings', 'questions', 'oauth_identities', 'oauth_states');

select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'question-images';
```

预期：

- 前四张业务表 `rowsecurity = true`（`oauth_states` 也可以开 RLS，但只由 service_role 使用）。
- `question-images.public = false`。
- 能看到 `questions`、`user_settings`、`profiles`、`storage.objects` 的 policy。

---

## 3. 配置 Authentication

进入 **Authentication → Providers**。

### 3.1 Phone（手机号验证码）

1. 启用 **Phone**。
2. 选择短信服务商。Supabase 内置支持 Twilio、MessageBird、Vonage、Textlocal 等；不同地区可用性不同。
3. 填写 provider 的 SID / Token / 发送号码。
4. 在 **Authentication → Rate Limits** 里确认 SMS 发送频率。测试阶段不要关闭限制。
5. 在 **Authentication → Settings** 确认：
   - **Allow new users to sign up** 开启（否则首次手机号登录无法自动创建账号）。
   - 如果开启了 CAPTCHA，前端需要接入 Turnstile token；当前代码未实现 CAPTCHA UI，建议首次部署先关闭 CAPTCHA，或自行在 `src/auth/auth-service.js` 的 `signInWithOtp` 调用中增加 `options.captchaToken`。

> **中国大陆短信说明**  
> Supabase 内置短信通道主要面向国际短信，国内到达率与资费取决于 provider。生产环境建议使用 Supabase 的 **Send SMS Hook** 接入阿里云 / 腾讯云短信，或使用支持中国区的事务性短信服务商。Hook 是 Supabase Auth 侧配置，不需要改本项目的登录代码。参考 [Supabase Send SMS Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook)。  
> 未配置短信服务商时，点击「获取验证码」会收到 `phone provider is not enabled` 或类似错误，这是后端配置问题，不是前端 bug。

### 3.2 Email（微信/QQ 登录需要）

微信/QQ 桥接使用 Supabase Admin `generateLink({ type: 'magiclink' })` 生成一次性 token。请确保 **Email provider 处于启用状态**，但不需要配置可发信的 SMTP：

- 启用 Email。
- 关闭 “Confirm email” 不影响管理员生成链接。
- 不需要把登录页暴露邮箱密码入口。

> 微信/QQ 用户使用合成邮箱，例如 `wx_xxx@oauth.your-domain.com`，不会真的收信。  
> 这个邮箱只作为 Supabase Auth 的唯一标识。合成邮箱域名在 Edge Function 的 `OAUTH_EMAIL_DOMAIN` 配置。

### 3.3 URL Configuration

进入 **Authentication → URL Configuration**。

**Site URL**：

```text
https://your-domain.com
```

**Redirect URLs** 至少加入：

```text
https://your-domain.com
https://your-domain.com/**
http://localhost:5173
http://localhost:5173/**
zhixi://auth/callback
```

说明：

- `zhixi://auth/callback` 是 Tauri / Android 的登录回跳地址。
- 如果部署在子路径，例如 `https://example.com/zhixi/`，Site URL 与 Redirect 都写完整子路径。
- Edge Function 的 `generateLink` 会使用 `redirectTo`，该地址必须命中上面的 allowlist。
- **不要**把 `*` 写进生产 allowlist；按域名精确配置。

---

## 4. 部署 OAuth Edge Function

完整 OAuth 平台配置见 [OAUTH_WECHAT_QQ.md](OAUTH_WECHAT_QQ.md)。这里只列 Supabase 侧操作。

### 4.1 准备 secrets

复制：

```bash
cp supabase/.env.functions.example supabase/.env.functions
```

填入微信/QQ 的 AppID、AppSecret、自定义回调域名等。然后：

```bash
supabase secrets set --env-file supabase/.env.functions
```

如果当前 CLI 不支持 `--env-file`，逐个设置：

```bash
supabase secrets set WECHAT_APP_ID=... WECHAT_APP_SECRET=...
supabase secrets set QQ_APP_ID=... QQ_APP_SECRET=...
supabase secrets set OAUTH_CALLBACK_BASE_URL=https://api.your-domain.com/functions/v1/oauth-bridge/callback
supabase secrets set OAUTH_ALLOWED_REDIRECTS=https://your-domain.com,zhixi://auth/callback
supabase secrets set OAUTH_EMAIL_DOMAIN=oauth.your-domain.com
```

> `OAUTH_CALLBACK_BASE_URL` 必须是**你控制的 HTTPS 自定义域名**，不能是 `https://xxxx.supabase.co/...`。原因见 OAuth 文档的“为什么需要自定义域名”。

### 4.2 部署

```bash
supabase functions deploy oauth-bridge --no-verify-jwt
```

`supabase/config.toml` 已设置：

```toml
[functions.oauth-bridge]
verify_jwt = false
```

为什么关闭 JWT 校验：`/start` 和 `/callback` 是浏览器重定向端点，不能要求 `Authorization` header。安全性靠：

- `oauth_states` 一次性 state + 10 分钟过期；
- `OAUTH_ALLOWED_REDIRECTS` 精确 allowlist；
- provider 的 code 只能换一次；
- 最终只返回一次性 `token_hash`，不返回 service_role 或长期 token。

### 4.3 自定义域名

Supabase 项目默认的 Functions 域名是 `https://<ref>.supabase.co/functions/v1/oauth-bridge`。微信/QQ 开放平台通常要求回调域名属于**你自己备案/可控的域名**，`*.supabase.co` 往往无法通过审核。

两种做法：

1. **Supabase Custom Domain**（推荐，若你的计划支持）：为项目绑定 `api.your-domain.com`，把 Functions 路由到该域名。
2. **反向代理**：用 Cloudflare Worker / Nginx / 云函数把  
   `https://api.your-domain.com/functions/v1/oauth-bridge/*`  
   代理到  
   `https://<ref>.supabase.co/functions/v1/oauth-bridge/*`，保留 path 和 query。设置 `OAUTH_CALLBACK_BASE_URL` 为代理后的完整地址。

**重要**：OAuth 函数会写入一个 HttpOnly 的 `zhixi_oauth_state` cookie，callback 时必须由同一个 host 带回，否则会被拒绝。因此：

- `VITE_OAUTH_BRIDGE_BASE_URL` 的 host 应与 `OAUTH_CALLBACK_BASE_URL` 的 host 完全一致；
- 推荐把两者都配置成同一个自定义域名，例如：
  - 前端：`https://api.your-domain.com/functions/v1/oauth-bridge`
  - 平台回调：`https://api.your-domain.com/functions/v1/oauth-bridge/callback`
- 只有自定义域名路由到了 Supabase Function，并且反向代理保留 `Set-Cookie` / `Cookie`，这套流程才成立。

如果只把 callback 换成自定义域名，而 `/start` 仍走 `*.supabase.co`，浏览器 cookie 落在另一个 host，授权回来会提示“登录状态与当前浏览器不匹配”。这是有意的 login CSRF 防护，不是 bug。

### 4.4 测试函数

在浏览器访问：

```text
https://YOUR_BRIDGE/functions/v1/oauth-bridge/start?provider=wechat&redirect_to=https%3A%2F%2Fyour-domain.com
```

如果返回 JSON 错误，通常是：

- 未配置 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`；
- `redirect` 不在 `OAUTH_ALLOWED_REDIRECTS`；
- 未部署成功 / secrets 未生效（重新 deploy 或等待几秒）。

---

## 5. Realtime

迁移 SQL 已执行：

```sql
alter publication supabase_realtime add table public.questions;
alter publication supabase_realtime add table public.user_settings;
```

在 **Database → Replication** 确认这两张表在 `supabase_realtime` publication 中。

如果迁移时提示 publication 不存在（极少见），在 Dashboard → Database → Replication 手动创建 publication `supabase_realtime`，再加入两张表。

Realtime 的 RLS：订阅时会以当前用户身份过滤；policy 已允许用户 select 自己的行。

> Realtime 是“另一台设备修改后立即刷新”的主要机制。即使 Realtime 推送失败，切回前台、联网、手动点“立即同步”仍会完成同步。

---

## 6. Storage

迁移 SQL 已创建私有桶：

- bucket：`question-images`
- public：`false`
- 文件大小：5 MB
- MIME：`image/jpeg`、`image/png`、`image/webp`

Storage policies：

- select / insert / update / delete 都要求对象路径第一段等于 `auth.uid()`。
- 客户端上传路径由 `src/cloud/cloud-sync.js` 生成：`<user_id>/<question_id>/<timestamp>-<random>.<ext>`。
- 读取使用 `createSignedUrls`，有效期 24 小时，不生成 public URL。

验证：

1. 用账号 A 登录，录入带图错题。
2. 在 Storage → `question-images` 中应看到 `A的user_id/...` 的图片。
3. 用账号 B 登录，前端不应能拉取 A 的图片；在 SQL Editor 以 B 的身份访问也应被 policy 拒绝。
4. 不要手动把 bucket 改为 public。

---

## 7. 前端环境变量

```bash
cp .env.example .env
```

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY

# OAuth 必须使用与 OAUTH_CALLBACK_BASE_URL 相同的自定义 host
VITE_OAUTH_BRIDGE_BASE_URL=https://api.your-domain.com/functions/v1/oauth-bridge

# 正式 Web 地址（必须与 Auth Site URL / Redirect URLs 一致）
VITE_APP_URL=https://your-domain.com

# 原生 App 登录回跳（Tauri / Capacitor）
VITE_NATIVE_DEEP_LINK=zhixi://auth/callback
```

重启 `pnpm dev`，或重新 `pnpm build`。Vite 的环境变量在构建时静态替换，修改 `.env` 后必须重启。

> 前端会检测常见的 `service_role` JWT 与 `sb_secret_` 前缀。误把 secret 写进 `.env` 时，登录页会直接报配置错误并拒绝创建 client；此时应立刻在 Supabase 轮换该密钥。

---

## 8. 用两个账号验证隔离

这是上线前最重要的一步。

1. 用手机号 A 登录，录入 1 道错题并加图片。
2. 用另一个浏览器 / 无痕窗口，以手机号 B 登录。
3. B 的错题本不应出现 A 的题目。
4. 用 B 在 Storage 控制台尝试打开 A 的对象路径，应被拒绝。
5. 还可以在 Supabase SQL Editor 使用 RLS 模拟：

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub', '<USER_A_UUID>', 'role', 'authenticated')::text, true);
set local role authenticated;
select count(*) from public.questions; -- 应只看到 A 的数据
rollback;
```

再以 `<USER_B_UUID>` 执行，数量应不同。RLS 的最终验证以两个真实登录会话为准。

如果两个账号能互相看到数据，**立即停止上线**，检查：

- 是否绕过 RLS 使用了 service_role；
- 是否把 `questions` 的 select policy 写成了 `using (true)`；
- 是否用了 public bucket。

---

## 9. 备份与恢复

Supabase 免费计划有数据库备份策略限制，建议：

- 在应用内定期「导出数据」，保存 JSON（含图片的 base64）；
- 付费计划开启 PITR / 每日备份；
- Storage 图片与数据库分开备份：数据库只存 path，图片在 bucket 中。

恢复顺序：

1. 先恢复数据库行；
2. 再恢复 Storage 对象到相同 path；
3. 用户重新登录后，签名 URL 会重新生成。

---

## 10. 常见 Supabase 错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `relation "public.questions" does not exist` | 迁移未执行 | 执行迁移 SQL |
| `new row violates row-level security policy` | 写入行的 `user_id` 不是当前 auth.uid，或 policy 缺失 | 检查客户端 upsert 的 `user_id` 与 policy |
| `Bucket not found` | Storage 迁移未执行 / bucket 名不一致 | 检查 `question-images` |
| 图片 403 | 签名 URL 过期；policy 不对；bucket 非私有但路径错误 | 重新同步刷新 URL；检查 Storage policy |
| Realtime 不更新 | 表未加入 publication；网络/WSS 被拦截 | 检查 Replication；手动同步兜底 |
| `phone provider is not enabled` | Phone provider 未启用 | Authentication → Providers → Phone |
| `Error sending confirmation OTP` | 短信服务商失败 / 目的地不支持 | 检查 provider 余额、号码格式、地区限制 |
| OAuth 登录后回到登录页 | `token_hash` 未验证成功 / Redirect 未允许 | 看 Edge Function 日志与浏览器 URL |
| `Invalid login credentials` | 使用了密码登录（本项目不用密码） | 确认调用的是 `verifyOtp` |

更多跨端问题见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
