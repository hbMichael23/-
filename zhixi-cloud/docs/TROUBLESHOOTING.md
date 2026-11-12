# 常见问题与排查

本文按“先判断在哪一层”组织：配置 → 登录 → 数据/RLS → 同步 → 图片 → OCR/公式 → 打包。

---

## 1. 启动后只看到登录页 / 提示 Supabase 未配置

**现象**

- 登录页右侧显示「还差一步配置」；
- 控制台没有网络请求。

**原因**

- `.env` 不存在，或 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 为空；
- 修改 `.env` 后没有重启 `pnpm dev` / 重新 `pnpm build`；
- 变量名写错（必须是 `VITE_` 前缀）。

**处理**

```bash
cp .env.example .env
# 填值
pnpm dev
```

检查浏览器 Network 是否请求 `https://xxxx.supabase.co/auth/v1/...`。

---

## 2. 手机验证码收不到

| 检查项 | 说明 |
| --- | --- |
| Supabase Phone Provider | Authentication → Providers → Phone 是否启用 |
| 短信服务商余额 | Twilio / Vonage 等是否欠费 |
| 目的地国家 | 某些 provider 默认屏蔽中国区 |
| 号码格式 | 前端会转成 E.164；中国手机号应为 `+8613...` |
| Rate Limit | 是否触发每小时上限 |
| CAPTCHA | 开启后前端需要传 captchaToken，本项目未内置 UI |
| 模板 | 短信模板是否审核通过 |

**大陆号码建议**：使用 Supabase Send SMS Hook 接阿里云 / 腾讯云短信。登录代码不需要改，只改 Supabase Auth 的 Hook。

错误 `phone provider is not enabled` 是后端未启用 Phone，不是前端 bug。

---

## 3. 登录成功但界面空白

**排查顺序**

1. 打开 DevTools Console，是否有 JS 异常。
2. Network 是否有 `/rest/v1/questions` 403。
3. 是否 `CloudSync.bootstrap` 超时后仍 boot（应显示本地缓存 + 离线提示）。
4. `#app` 是否仍 `visibility: hidden`：
   - 正常登录后 `body.app-ready` 会被加上；
   - 如果代码在 `boot` 阶段抛错，会回到登录页。

如果是 403：

- RLS 拒绝：检查 questions policy 与 `user_id`；
- JWT 过期：退出重登；
- 用了错误的 Supabase URL（指向另一个项目）。

---

## 4. RLS 相关

### 4.1 写入报 `new row violates row-level security policy`

- 客户端 upsert 的行里 `user_id` 不是当前 `auth.uid()`；
- `questions` 的 insert/update policy 不存在；
- 用 anon key 但未登录（JWT 为空）。

### 4.2 能读到自己数据，但读不到别人的（这是正常的）

RLS 的目的就是隔离。不要为了“方便”把 policy 改成 `using (true)`。

### 4.3 两个账号能互相看到数据

**立即停用生产环境**，检查：

- 是否在某处用了 service_role 查询；
- 是否在 Supabase Dashboard 关闭了 RLS；
- 是否把 bucket 改成 public；
- 是否加了 `using (true)`。

---

## 5. Storage / 图片

### 5.1 上传 403 / `new row violates row-level security policy`

- 对象路径必须以 `<user_id>/` 开头；
- Storage policy 使用 `storage.foldername(name)[1]`，检查 SQL 是否执行；
- bucket 必须是 private。

### 5.2 图片在另一台设备显示裂图

- 签名 URL 24 小时过期；
- 在设置页点「立即同步」刷新；
- 如果离线超过 24 小时，本地缓存里的签名 URL 已过期，联网同步后恢复；
- 这是私有桶 + 签名 URL 的取舍：本地缓存的是 URL，不是图片二进制。文本与复习记录不受影响。

### 5.3 图片上传失败但文字同步了

- 同步状态会显示「部分图片上传失败」；
- 会自动重试（约 30 秒）；
- 检查 Storage 配额、文件大小（>5 MB）、MIME；
- 原图在本地 localStorage 里可能很大，先导出备份再重试。

### 5.4 删除题目后换了设备又出现

- 正常情况使用软删除墓碑，不应复活；
- 如果旧设备上有比删除时间更新的本地编辑，按 Last-Write-Wins 会复活；
- 这是有意行为：说明旧设备在删除后仍修改过该题；
- 若确认是 bug，检查 `deleted_at` 是否写入、`pendingDeletes` 是否被清空。

---

## 6. 同步

### 6.1 状态一直「有改动待同步」

- 网络不可用；
- 图片上传失败；
- Storage 删除旧对象失败；
- Supabase 429 / 5xx。

点「立即同步」看 toast，再开 DevTools Network 看失败请求。  
本地缓存不会丢，联网后重试。

### 6.2 另一台设备不自动刷新

- Supabase Realtime 是否开启；
- `questions` / `user_settings` 是否在 `supabase_realtime` publication；
- 企业网络 / 代理是否拦截 WSS；
- 前端切回前台、恢复网络或手动同步都会兜底。

### 6.3 同一题在两台设备上互相覆盖

- 当前策略是每条题 Last-Write-Wins；
- `review_history` 取并集，但题干/标签等字段以更新时间为准；
- 同时编辑不同字段仍可能覆盖，这是简化同步模型的边界。

### 6.4 退出登录后本地数据还在吗？

- 本地缓存按 `zhixi_wrongbook_v1:<user_id>` 保留；
- 同一账号再次登录会继续用该缓存并同步；
- 换账号看不到其他账号的缓存；
- 本地缓存不是加密存储，共用电脑/手机应在退出后清除浏览器站点数据；
- 清除浏览器站点数据会删除本地缓存，云端数据仍在（可重新拉取）。

### 6.5 导入含大量图片的 JSON 失败

当前导入仍沿用原版的 localStorage 持久化方式：导入的 base64 图片会先写入浏览器缓存，再由云端同步上传并替换为签名 URL。

如果一次性导入几十张图，可能先触发 `QuotaExceededError`，即使云端空间充足。处理：

1. 用文本编辑器把备份 JSON 的 `questions` 数组拆成小批（例如每批 5–10 道带图题）；
2. 导入一批 → 等设置页状态显示「云端已同步」→ 再导入下一批；
3. 不要直接删掉原备份，确认云端和导出都完整后再清理。

这是"先本地、后云同步"架构的边界，不是 Supabase Storage 容量限制。

### 6.6 旧版单文件知隙的数据

- 旧数据在 localStorage key `zhixi_wrongbook_v1`；
- 新版本不会自动导入，避免把旧数据误合并到错误账号；
- 登录后 → 设置 → 账号卡下方「导入本机旧数据」；
- 导入后会自动同步，并写入迁移标记，避免重复导入；
- 为了给新缓存腾出 localStorage 配额，**迁移成功后会删除旧 key**；失败时会尽量恢复原始旧数据；
- 导入前建议先在旧版导出 JSON 备份。

---

## 7. 微信 / QQ 登录

### 7.1 点击后提示「未配置 / 登录服务暂时不可用」

- Edge Function secrets 缺失；
- secrets 设置了但没有重新 deploy；
- 检查 `supabase functions logs oauth-bridge`。

### 7.2 `登录状态与当前浏览器不匹配`

- `/start` 与 `/callback` host 不同；
- 反向代理没有转发 Cookie / Set-Cookie；
- 浏览器禁用了 cookie；
- 用户把授权链接复制到了另一个浏览器。

处理：让 `VITE_OAUTH_BRIDGE_BASE_URL` 与 `OAUTH_CALLBACK_BASE_URL` 使用同一自定义 host，代理保留 cookie。

### 7.3 授权后一直回到登录页

- 回调 URL 带了 `auth_error`，但前端未展示；
- `token_hash` 已过期 / 已使用；
- Supabase Auth Redirect URLs 没有包含 `VITE_APP_URL`；
- `verifyOtp` 失败。

看浏览器地址栏是否有：

```text
?token_hash=...&type=email&provider=wechat
```

如果没有，说明 Edge 没成功生成 token；看函数日志。

### 7.4 微信提示 `redirect_uri 参数错误`

- 开放平台授权回调域未配置 / 未审核；
- 回调域名与 `OAUTH_CALLBACK_BASE_URL` 不一致；
- 使用了 `*.supabase.co`。

### 7.5 QQ 提示 `redirect uri is illegal`

- QQ 对协议、域名、端口、路径、末尾斜杠完全匹配；
- token 交换时使用的 callback 必须与授权时完全一致；
- 本项目统一使用 `OAUTH_CALLBACK_BASE_URL`，不要在平台额外加 query。

### 7.6 原生 App 回跳失败

- AndroidManifest 未加 intent-filter；
- 修改 manifest 后没重新安装 APK；
- Tauri 未启用 deep-link / single-instance；
- Supabase Auth Redirect URLs / `OAUTH_ALLOWED_REDIRECTS` 缺 `zhixi://auth/callback`。

---

## 8. OCR

### 8.1 一直「正在加载识别引擎」

- Tesseract 从 CDN 加载失败；
- 公司网络 / 防火墙拦截 jsdelivr / unpkg / cdnjs；
- 首次需下载约 6 MB 语言模型。

排查：

```text
https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/worker.min.js
https://unpkg.com/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js
https://unpkg.com/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz
```

如果公司网络无法访问，需要把 worker / core / 语言模型改成本地静态资源。

### 8.2 识别结果乱码

- 图片太模糊 / 倾斜；
- 公式和手写体不适合 OCR；
- 可先用相册选择清晰图片，识别后手动修正 LaTeX；
- 中文与英文混排时，语言包设置会影响结果。

### 8.3 识别完成但公式不渲染

- OCR 不会自动把公式转 LaTeX；
- 需要在题干中手动写 `$...$` / `$$...$$`；
- 检查 MathJax 是否加载成功（Console 是否有 CDN 报错）。

---

## 9. MathJax

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 公式显示为原始 `$...$` | MathJax 未加载 / 配置未生效 | 看 Network 与 Console |
| 公式换行错乱 | Tailwind preflight 的 svg display | 项目已在 legacy.css 修复；不要删 `mjx-container > svg` 规则 |
| 编辑区公式不实时 | 输入时只做延迟渲染 | 失焦 / 保存后刷新预览 |
| CDN 被墙 | 网络问题 | 换可用 CDN 或本地托管 |

---

## 10. Web 构建 / 部署

### 10.1 `pnpm install` 报 esbuild 构建脚本被忽略

pnpm 10/11 默认阻止依赖运行 postinstall。项目已提供：

```text
pnpm-workspace.yaml
```

```yaml
onlyBuiltDependencies:
  - esbuild
```

如果仍报错：

```bash
pnpm approve-builds --all
pnpm rebuild esbuild
```

并确保 `node` 在 PATH 中（pnpm 执行 postinstall 时需要）。

### 10.2 构建成功但线上白屏

- `base: './'` 下资源路径是否相对；
- 是否把 `dist/` 部署到了错误目录；
- 是否用 `file://` 直接打开 `index.html`（ES Module 会被 CORS 阻止，必须 HTTP 服务）；
- 控制台看 404。

### 10.3 修改 `.env` 不生效

Vite 变量在构建时注入。执行：

```bash
pnpm build
```

而不是只重启静态服务器。

### 10.4 部署到子路径

- `VITE_APP_URL` 写完整子路径；
- Supabase Auth Redirect URLs 写完整子路径；
- Nginx / 托管 rewrite 指向子目录 `index.html`。

---

## 11. 原生壳差异

### 11.1 Tauri 白屏 / CSP 报错

- 检查 `tauri.conf.json` 的 CSP；
- 自定义 Supabase 域名必须加入 `connect-src` / `img-src`；
- 开发模式与生产模式的 origin 不同，CSP 都要覆盖。

### 11.2 Capacitor 白屏

- `pnpm build` 后再 `pnpm cap:sync`；
- `adb logcat` 看 console；
- WebView 版本过旧；
- 不要直接改 `android/app/src/main/assets/public` 里的构建产物，下一次 sync 会覆盖。

### 11.3 文件导出失败

- Tauri：检查 `save_backup_file` command 是否注册；
- Android：检查 Filesystem / Share 插件是否 sync；
- 用户取消保存是正常路径，不应报错；
- 如果 Share 无法分享文件，检查 Android FileProvider 配置。

### 11.4 系统通知

- Web 端使用浏览器 Notification API；
- Android WebView / Tauri WebView 对通知支持有限；
- 本项目未接入原生 LocalNotifications / Tauri Notification；
- 页面内到期提醒在所有端都可用。

---

## 12. 数据恢复

### 12.1 误删题目

- 当前没有“回收站” UI；
- 如果另一台设备仍有缓存，可能可以恢复；
- 最可靠的是导入之前的 JSON 备份；
- 云端软删除行仍在表中，可由管理员在 SQL Editor 按 `deleted_at` 恢复（高风险，先备份）。

### 12.2 本地缓存损坏

- 打开 DevTools → Application → Local Storage；
- 找到 `zhixi_wrongbook_v1:<user_id>`；
- 先复制内容到文本文件备份；
- 再决定是否清除；
- 清除后重新登录会从云端拉取。

> 不要在没有备份的情况下清空站点数据。

### 12.3 账号无法登录

- 手机号：检查短信服务商 / 号码；
- 微信/QQ：检查开放平台应用状态、回调域名、secrets；
- 如果 Supabase 用户还在，可以换一种登录方式（但微信/QQ 与手机号是独立账号）；
- 管理员可在 Supabase Auth → Users 查看用户状态。

---

## 13. 有用的调试命令 / 位置

```bash
# 前端
pnpm dev
pnpm build
pnpm preview

# Supabase
supabase functions logs oauth-bridge
supabase secrets list

# Android
adb logcat | grep -i chromium
adb shell am start -a android.intent.action.VIEW -d "zhixi://auth/callback?token_hash=test&type=email"

# Tauri
pnpm tauri:dev
```

浏览器关键位置：

- Console
- Network → Fetch/XHR / WS
- Application → Local Storage
- Application → Cookies（`zhixi_oauth_state` 在 OAuth 自定义域名下）

---

## 14. 不要做的事

- 不要把 `service_role` key 放进 `.env`、前端代码或 GitHub Actions 的前端构建变量。
- 不要把 Storage bucket 改成 public 来“解决图片 403”。
- 不要关闭 RLS 来“解决同步问题”。
- 不要在未备份时清空 localStorage。
- 不要把微信/QQ 的 AppSecret 提交到仓库。
- 不要忽略 OAuth state / cookie 错误；那是安全机制。
