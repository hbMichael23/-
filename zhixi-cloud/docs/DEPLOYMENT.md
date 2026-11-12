# 网站部署

本项目是**纯静态 SPA**：构建后只需要托管 `dist/`，没有 Node 服务端。  
登录、数据库、图片与 OAuth 都在 Supabase。

---

## 1. 构建前检查

- [ ] `supabase/migrations/20261112000000_init.sql` 已在生产项目执行。
- [ ] Phone Provider 与短信服务商已配置。
- [ ] Email Provider 已启用（微信/QQ 的 magiclink 需要）。
- [ ] `oauth-bridge` 已部署，secrets 已生效。
- [ ] 微信 / QQ 回调域名已审核通过。
- [ ] Supabase Auth 的 Site URL / Redirect URLs 已加入正式域名。
- [ ] `.env` 只包含 anon key，不包含 service_role。
- [ ] `VITE_OAUTH_BRIDGE_BASE_URL` 与 `OAUTH_CALLBACK_BASE_URL` 同 host。
- [ ] 已准备 HTTPS 证书。

---

## 2. 本地生产构建

```bash
pnpm install
pnpm build
pnpm preview
```

`vite.config.js` 设置了：

```js
base: './'
```

因此 `dist/index.html` 使用相对路径，可以部署在：

- 根域名 `https://your-domain.com/`
- 子路径 `https://your-domain.com/zhixi/`

Vite 会把 `VITE_*` 环境变量在构建时写入 JS。**修改 `.env` 后必须重新构建**，仅重启静态服务器无效。

---

## 3. 环境变量

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_OAUTH_BRIDGE_BASE_URL=https://api.your-domain.com/functions/v1/oauth-bridge
VITE_APP_URL=https://your-domain.com
VITE_NATIVE_DEEP_LINK=zhixi://auth/callback
```

### `VITE_APP_URL` 的规则

- 必须是完整 URL，以 `https://` 开头（本地可用 `http://localhost:5173`）。
- 必须与 Supabase Auth → Site URL 一致。
- 如果部署在子路径，必须包含子路径：

```text
https://your-domain.com/zhixi/
```

- OAuth 成功后浏览器会回到 `VITE_APP_URL`，再带 `?token_hash=...`。
- 不要在末尾随机加 query，避免与 `generateLink` 的 redirectTo 不一致。

---

## 4. Vercel

1. 把仓库推到 GitHub / GitLab。
2. Vercel → Add New Project → Import。
3. 配置：
   - Framework Preset：Vite
   - Build Command：`pnpm build`
   - Output Directory：`dist`
   - Install Command：`pnpm install`
4. Environment Variables 添加上面的 5 个变量（Production / Preview 分开）。
5. Deploy。
6. 绑定自定义域名，开启 HTTPS。
7. 把 Vercel 域名和自定义域名加入 Supabase Auth Redirect URLs：

```text
https://your-project.vercel.app
https://your-project.vercel.app/**
https://your-domain.com
https://your-domain.com/**
```

> Preview 部署的域名每次不同。要么为 Preview 配置固定分支域名，要么不要把 Preview URL 加进 allowlist，只在生产测试 OAuth。

Hash 路由（`#/library`）不需要服务端 rewrite；直接访问根路径即可。  
如果以后改成 History 路由，再补 `vercel.json` rewrite。

---

## 5. Netlify

仓库已包含：

```text
public/_redirects
```

内容：

```text
/* /index.html 200
```

Netlify 配置：

- Build command：`pnpm build`
- Publish directory：`dist`
- Environment：同上 5 个变量

---

## 6. Cloudflare Pages

1. Pages → Create a project → Connect to Git。
2. Framework preset：Vite。
3. Build command：`pnpm build`。
4. Build output directory：`dist`。
5. 添加环境变量。
6. 绑定自定义域名。
7. 在 Supabase Auth Redirect URLs 加入正式域名。

Cloudflare 的静态资源缓存通常自动处理。若手动配置缓存：

- `assets/*`：长缓存（文件名带 hash）；
- `index.html`：`no-cache`。

---

## 7. Nginx / 自建服务器

把 `dist/` 上传到服务器，例如 `/var/www/zhixi`。

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    root /var/www/zhixi;
    index index.html;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # 如果反向代理 OAuth Edge Function，需要保留 Cookie / Set-Cookie
    location /functions/v1/oauth-bridge/ {
        proxy_pass https://YOUR_PROJECT_REF.supabase.co/functions/v1/oauth-bridge/;
        proxy_set_header Host YOUR_PROJECT_REF.supabase.co;
        proxy_set_header X-Forwarded-Proto https;
        proxy_cookie_domain YOUR_PROJECT_REF.supabase.co api.your-domain.com;
        proxy_redirect off;
    }
}
```

注意：

- `/start` 与 `/callback` 的 host 必须相同，cookie 才会带上。
- 反向代理不要缓存 302；`cache-control: no-store` 已由函数设置。
- 不要开启 `proxy_hide_header Set-Cookie`。

---

## 8. 子路径部署

Vite 的 `base: './'` 支持相对资源，但有两处仍需手动配置：

1. `VITE_APP_URL` 必须包含子路径；
2. Supabase Auth 的 Site URL / Redirect URLs 必须包含子路径；
3. 微信/QQ 的 OAuth 最终回跳是 Edge Function 的 `redirect_to`，它由前端传入，所以会自动带上子路径。

例如：

```text
https://your-domain.com/zhixi/
```

Nginx 的 `try_files` 要指向子目录的 `index.html`。

---

## 9. OAuth 自定义域名

部署 Web 站和 OAuth 是两件事：

- Web 站：`https://your-domain.com`
- OAuth 函数：`https://api.your-domain.com/functions/v1/oauth-bridge`

必须保证：

```text
VITE_OAUTH_BRIDGE_BASE_URL
  = https://api.your-domain.com/functions/v1/oauth-bridge

OAUTH_CALLBACK_BASE_URL
  = https://api.your-domain.com/functions/v1/oauth-bridge/callback
```

两者 host 一致。详细原因与代理示例见 [OAUTH_WECHAT_QQ.md](OAUTH_WECHAT_QQ.md)。

---

## 10. 部署后验收清单

### 登录

- [ ] 未登录时只能看到登录页，看不到任何错题数据。
- [ ] 手机号验证码可以收到并登录。
- [ ] 刷新页面后仍保持登录。
- [ ] 退出登录后回到登录页。
- [ ] 未配置短信时会显示友好错误，而不是白屏。

### 数据

- [ ] 录入一道题，刷新后仍在。
- [ ] 上传图片，关闭页面重开，图片仍显示。
- [ ] 两个浏览器同账号，A 修改后 B 能在几秒内看到（或手动同步）。
- [ ] 断网后录入，联网后自动同步。
- [ ] 删除题目后，另一台设备不再显示。
- [ ] 导出 JSON，导入到另一个账号，图片与公式完整。
- [ ] 在设置页导入旧版单文件数据成功。

### 安全

- [ ] 两个不同账号无法互查数据。
- [ ] Storage bucket 仍为 private。
- [ ] 禁止 service_role 出现在浏览器 bundle：

```bash
grep -R "service_role" dist || true
```

- [ ] 浏览器控制台无 Supabase 401/403（除了预期错误）。
- [ ] OAuth callback 复制到另一个浏览器被拒绝。

### 性能

- [ ] 首屏不加载 OCR 模型，只有点击识别时才加载。
- [ ] MathJax CDN 可访问。
- [ ] 图片上传后 localStorage 不再保留大 base64。
- [ ] 移动端 390px 宽度无横向滚动。

---

## 11. CI 示例（GitHub Actions）

```yaml
name: build

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm build
        env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
          VITE_OAUTH_BRIDGE_BASE_URL: ${{ secrets.VITE_OAUTH_BRIDGE_BASE_URL }}
          VITE_APP_URL: ${{ secrets.VITE_APP_URL }}
          VITE_NATIVE_DEEP_LINK: zhixi://auth/callback

      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist
```

> GitHub Actions 的 `secrets` 只放 anon key。service_role 永远不要放在前端构建环境。

---

## 12. 回滚

静态站回滚：

- Vercel / Netlify / Cloudflare：在 Deployments 中选择上一个成功部署，Promote / Rollback。
- 自建 Nginx：保留上一版 `dist` 目录，切换 symlink。

数据库回滚：

- 不要直接在生产执行 `drop table`。
- 迁移 SQL 只做增量；结构变更请新增 migration。
- 大版本前在 Supabase 控制台创建数据库备份 / 开启 PITR。

---

## 13. 常见部署错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面 404（刷新 /library） | 托管未配置 SPA fallback | 加 `_redirects` 或 `try_files`；本项目使用 hash，通常不会触发 |
| 白屏，控制台 404 `/assets/...` | `base` 配置 / 子路径不对 | 保持 `base: './'`，用子目录完整 URL |
| 登录后刷新回到登录页 | Supabase URL / key 配置错误；cookie/session 被清 | 检查 `.env`，重新 build；确认不是 file:// 打开 |
| `Invalid redirect URL` | `VITE_APP_URL` 未加入 Supabase Auth Redirect URLs | 加入完整 URL 与 `/**` |
| 微信回调 404 | 自定义域名未代理到 Edge Function | 检查反向代理路径与 TLS |
| 图片 403 | 签名 URL 过期 / bucket policy | 重新登录或手动同步；检查 Storage policy |
| 构建后变量不生效 | Vite 构建时注入，需重新 build | 重新 `pnpm build` |
| 上传大图失败 | Storage 5 MB 限制 / 压缩失败 | 降低图片质量或调整 bucket 限制与 SQL check |
| OCR 一直加载 | CDN 被墙 / CSP | 浏览器直接打开 cdnjs 链接；Tauri 检查 CSP |
