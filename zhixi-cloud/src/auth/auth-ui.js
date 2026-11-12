import {
  getAuthConfigState,
  requestPhoneOtp,
  verifyPhoneOtp,
  startThirdPartyLogin,
  formatAuthError,
  normalizePhone,
  maskPhone
} from './auth-service.js';
import { isNativeApp } from '../lib/platform.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char] ?? char));
}

const BRAND_MARK = `<span class="auth-logo-mark"><span>隙</span></span>`;

const WECHAT_ICON = `
  <span class="auth-oauth-glyph auth-oauth-glyph-wechat" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M9.1 4.2C5.2 4.2 2 6.8 2 10c0 1.8 1.1 3.4 2.9 4.5l-.7 2.2 2.6-1.3c.7.2 1.5.3 2.3.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M14.7 8.5c-4.1 0-7.4 2.7-7.4 6s3.3 6 7.4 6c.9 0 1.7-.1 2.5-.4l2.8 1.4-.7-2.4c1.5-1.1 2.4-2.7 2.4-4.6 0-3.3-3.3-6-7-6Z" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/>
      <circle cx="7.8" cy="9.5" r=".8" fill="currentColor"/><circle cx="11" cy="9.5" r=".8" fill="currentColor"/>
      <circle cx="12.8" cy="14.4" r=".8" fill="currentColor"/><circle cx="16.3" cy="14.4" r=".8" fill="currentColor"/>
    </svg>
  </span>
`;

const QQ_ICON = `
  <span class="auth-oauth-glyph auth-oauth-glyph-qq" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 3.4c2.4 0 4.1 1.8 4.1 4.6 0 .9.2 1.5.8 2.4 1.1 1.6 2.1 3.5 2.1 5.4 0 1.2-.6 2.1-1.5 2.1-.6 0-1.1-.3-1.6-.9-.7 1.8-2.2 3-3.9 3s-3.2-1.2-3.9-3c-.5.6-1 .9-1.6.9-.9 0-1.5-.9-1.5-2.1 0-1.9 1-3.8 2.1-5.4.6-.9.8-1.5.8-2.4 0-2.8 1.7-4.6 4.1-4.6Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
      <circle cx="9.7" cy="8" r=".7" fill="currentColor"/><circle cx="14.3" cy="8" r=".7" fill="currentColor"/>
      <path d="M10.8 11.3c.4.5.8.7 1.2.7s.8-.2 1.2-.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  </span>
`;

export class AuthUI {
  constructor() {
    this.root = null;
    this.configState = getAuthConfigState();
    this.cooldownTimer = null;
    this.cooldownEndsAt = 0;
    this.busy = false;
    this.lastPhone = '';
    this.mode = 'loading';
    this.boundClick = this.handleClick.bind(this);
    this.boundSubmit = this.handleSubmit.bind(this);
    this.boundInput = this.handleInput.bind(this);
  }

  init() {
    this.root = document.getElementById('auth-root');
    if (!this.root) return;
    this.root.addEventListener('click', this.boundClick);
    this.root.addEventListener('submit', this.boundSubmit);
    this.root.addEventListener('input', this.boundInput);
    this.showLoading();
  }

  setRootVisible(visible) {
    if (!this.root) return;
    this.root.hidden = !visible;
    this.root.classList.toggle('is-hidden', !visible);
  }

  clearCooldown() {
    if (this.cooldownTimer) window.clearInterval(this.cooldownTimer);
    this.cooldownTimer = null;
    this.cooldownEndsAt = 0;
  }

  showLoading(message = '正在连接知隙…') {
    if (!this.root) return;
    this.clearCooldown();
    this.mode = 'loading';
    this.setRootVisible(true);
    this.root.innerHTML = this.loadingMarkup(message);
  }

  showSyncing(message = '登录成功，正在同步你的云端错题…') {
    if (!this.root) return;
    this.clearCooldown();
    this.mode = 'syncing';
    this.setRootVisible(true);
    this.root.innerHTML = this.syncingMarkup(message);
  }

  hide() {
    this.clearCooldown();
    this.setRootVisible(false);
  }

  showConfigError() {
    if (!this.root) return;
    this.clearCooldown();
    this.mode = 'config-error';
    this.setRootVisible(true);
    this.root.innerHTML = this.shell(`
      <div class="auth-card">
        <div class="auth-mobile-brand">${BRAND_MARK}<span>知隙</span></div>
        <p class="auth-kicker">SETUP REQUIRED</p>
        <h2 class="auth-heading">还差一步配置</h2>
        <p class="auth-subheading">${esc(this.configState.error || 'Supabase 环境变量尚未配置。')}</p>
        <div class="auth-codebox">
          <p>在项目根目录创建 <code>.env</code>（可复制 <code>.env.example</code>），填入：</p>
          <pre>VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY</pre>
          <p>然后重启 <code>npm run dev</code> 或重新执行 <code>npm run build</code>。</p>
        </div>
        <p class="auth-fineprint">详细步骤：<code>docs/SUPABASE_SETUP.md</code> 与 <code>docs/DEPLOYMENT.md</code></p>
      </div>
    `, { compact: true });
  }

  showLogin(options = {}) {
    if (!this.root) return;
    if (!this.configState.configured) {
      this.showConfigError();
      return;
    }
    this.clearCooldown();
    this.mode = 'login';
    this.busy = false;
    this.setRootVisible(true);
    this.lastPhone = options.phone || this.lastPhone || '';
    this.root.innerHTML = this.shell(`
      <div class="auth-card">
        <div class="auth-mobile-brand">
          ${BRAND_MARK}
          <span>知隙 <small>ZHIXI</small></span>
        </div>
        <div class="auth-card-head">
          <p class="auth-kicker">PRIVATE CLOUD NOTEBOOK</p>
          <h2 class="auth-heading">登录知隙</h2>
          <p class="auth-subheading">手机号验证码，或使用微信 / QQ 授权。登录后，错题按账号隔离并自动同步。</p>
        </div>

        <div id="auth-message" class="auth-message ${options.error ? 'is-error' : ''}" role="status" aria-live="polite">${esc(options.error || options.notice || '')}</div>

        <form id="phone-login-form" class="auth-form" novalidate>
          <label class="auth-label" for="auth-phone">手机号</label>
          <div class="auth-phone-field">
            <span class="auth-prefix">+86</span>
            <input id="auth-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="请输入 11 位手机号" value="${esc(this.lastPhone.replace(/^\+?86/, ''))}" maxlength="18">
          </div>
          <label class="auth-label" for="auth-code">短信验证码</label>
          <div class="auth-code-row">
            <input id="auth-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" maxlength="8" class="auth-code-input">
            <button type="button" data-auth-action="send-code" class="auth-code-button">获取验证码</button>
          </div>
          <button type="submit" class="auth-primary-button" data-auth-action="verify-code">
            <span>登录 / 注册</span>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <p class="auth-helper">未注册手机号将自动创建账号；验证码由 Supabase Auth 发送。</p>
        </form>

        <div class="auth-divider"><span>或使用第三方账号</span></div>

        <div class="auth-oauth-grid">
          <button type="button" data-auth-action="oauth" data-provider="wechat" class="auth-oauth-button auth-oauth-button-wechat">
            ${WECHAT_ICON}<span>微信登录</span>
          </button>
          <button type="button" data-auth-action="oauth" data-provider="qq" class="auth-oauth-button auth-oauth-button-qq">
            ${QQ_ICON}<span>QQ 登录</span>
          </button>
        </div>

        <p class="auth-legal">登录即表示你同意知隙的服务与隐私说明。错题数据存储在 Supabase，数据库启用行级安全（RLS），每个账号只能访问自己的数据。</p>
      </div>
      <p class="auth-page-foot">${isNativeApp() ? 'App 版本 · 手机号验证码可直接登录' : 'Web 版本 · 多设备自动同步'}</p>
    `, { compact: false });

    const phoneInput = this.root.querySelector('#auth-phone');
    if (phoneInput && this.lastPhone) {
      const codeInput = this.root.querySelector('#auth-code');
      if (codeInput) codeInput.focus({ preventScroll: true });
    }
    if (options.error) {
      this.scrollMessageIntoView();
    }
  }

  shell(content, options = {}) {
    return `
      <div class="auth-page">
        <div class="auth-page-lines" aria-hidden="true"></div>
        <div class="auth-shell ${options.compact ? 'is-compact' : ''}">
          <section class="auth-story">
            <div class="auth-brand">
              ${BRAND_MARK}
              <span>
                <strong>知隙</strong>
                <small>ZHIXI · 985 ECON</small>
              </span>
            </div>
            <div class="auth-story-copy">
              <p class="auth-story-kicker">A PRIVATE NOTEBOOK FOR THE LONG RUN</p>
              <h1>把错题留在云端，<br><em>把专注留给书桌。</em></h1>
              <p class="auth-story-lead">面向顶尖 985 经济学考研。拍照识别、公式排版、艾宾浩斯复习，所有数据都只属于你。</p>
              <ul class="auth-feature-list">
                <li><span>01</span><div><strong>本地 OCR</strong><small>原图不上传识别服务</small></div></li>
                <li><span>02</span><div><strong>账号隔离</strong><small>Supabase RLS 行级安全策略</small></div></li>
                <li><span>03</span><div><strong>多设备接续</strong><small>云端自动同步错题、复习与标签</small></div></li>
              </ul>
            </div>
            <div class="auth-quote">
              <p>博学之，审问之，慎思之，明辨之，笃行之。</p>
              <span>《礼记 · 中庸》</span>
            </div>
          </section>

          <section class="auth-panel">
            ${content}
          </section>
        </div>
      </div>
    `;
  }

  loadingMarkup(message) {
    return this.shell(`
      <div class="auth-card auth-card-centered">
        <div class="auth-spinner" aria-hidden="true"></div>
        <p class="auth-kicker">ZHIXI CLOUD</p>
        <h2 class="auth-heading">${esc(message)}</h2>
        <p class="auth-subheading">正在校验登录状态，请稍候。</p>
      </div>
    `, { compact: true });
  }

  syncingMarkup(message) {
    return this.shell(`
      <div class="auth-card auth-card-centered">
        <div class="auth-sync-mark" aria-hidden="true">
          <span></span>
          <svg viewBox="0 0 24 24" fill="none"><path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19 12a7 7 0 0 0-12-5L4 10m1 2a7 7 0 0 0 12 5l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <p class="auth-kicker">SECURELY CONNECTING</p>
        <h2 class="auth-heading">${esc(message)}</h2>
        <p class="auth-subheading">正在拉取你的错题、复习记录与标签，请保持页面打开。</p>
        <div class="auth-progress"><span></span></div>
      </div>
    `, { compact: true });
  }

  setMessage(text, tone = 'info') {
    const el = this.root?.querySelector('#auth-message');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', tone === 'error');
    el.classList.toggle('is-success', tone === 'success');
    el.classList.toggle('is-empty', !text);
    if (text) this.scrollMessageIntoView();
  }

  scrollMessageIntoView() {
    const el = this.root?.querySelector('#auth-message');
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  setBusy(busy, label = '') {
    this.busy = Boolean(busy);
    const verify = this.root?.querySelector('[data-auth-action="verify-code"]');
    if (verify) {
      verify.disabled = Boolean(busy);
      verify.classList.toggle('is-loading', Boolean(busy));
      const span = verify.querySelector('span');
      if (span) span.textContent = busy ? (label || '请稍候…') : '登录 / 注册';
    }
    this.root?.querySelectorAll('[data-auth-action="oauth"], [data-auth-action="send-code"]').forEach((button) => {
      button.disabled = Boolean(busy);
    });
  }

  startCooldown(seconds = 60) {
    this.clearCooldown();
    this.cooldownEndsAt = Date.now() + seconds * 1000;
    this.updateCooldownLabel();
    this.cooldownTimer = window.setInterval(() => {
      if (!this.updateCooldownLabel()) this.clearCooldown();
    }, 1000);
  }

  updateCooldownLabel() {
    const button = this.root?.querySelector('[data-auth-action="send-code"]');
    if (!button) return false;
    const remaining = Math.max(0, Math.ceil((this.cooldownEndsAt - Date.now()) / 1000));
    button.disabled = this.busy || remaining > 0;
    button.textContent = remaining > 0 ? `重新发送 ${remaining}s` : '获取验证码';
    return remaining > 0;
  }

  async handleClick(event) {
    const target = event.target.closest('[data-auth-action]');
    if (!target || this.busy) return;
    const action = target.getAttribute('data-auth-action');
    if (action === 'oauth') {
      event.preventDefault();
      await this.handleOAuth(target.getAttribute('data-provider'));
    }
    if (action === 'send-code') {
      event.preventDefault();
      await this.handleSendCode();
    }
  }

  async handleSubmit(event) {
    if (event.target?.id !== 'phone-login-form') return;
    event.preventDefault();
    if (this.busy) return;
    await this.handleVerifyCode();
  }

  handleInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.id === 'auth-phone') {
      input.value = input.value.replace(/[^\d+\s-]/g, '');
    }
    if (input.id === 'auth-code') {
      input.value = input.value.replace(/\D/g, '').slice(0, 8);
    }
    if (this.root.querySelector('#auth-message')?.textContent) {
      this.setMessage('');
    }
  }

  readPhone() {
    const input = this.root?.querySelector('#auth-phone');
    const normalized = normalizePhone(input?.value || '');
    if (!normalized) {
      this.setMessage('请输入正确的手机号。中国大陆手机号可直接输入 11 位号码。', 'error');
      input?.focus();
      return null;
    }
    return normalized;
  }

  async handleSendCode() {
    const phone = this.readPhone();
    if (!phone) return;
    this.setMessage('');
    const button = this.root?.querySelector('[data-auth-action="send-code"]');
    if (button) {
      button.disabled = true;
      button.textContent = '发送中…';
    }
    try {
      const normalized = await requestPhoneOtp(phone);
      this.lastPhone = normalized;
      this.setMessage(`验证码已发送至 ${maskPhone(normalized)}，验证码几分钟内有效。`, 'success');
      this.startCooldown(60);
      this.root?.querySelector('#auth-code')?.focus({ preventScroll: true });
    } catch (error) {
      this.setMessage(formatAuthError(error, '验证码发送失败，请稍后重试。'), 'error');
      if (button) {
        button.disabled = false;
        button.textContent = '获取验证码';
      }
    }
  }

  async handleVerifyCode() {
    const phone = this.readPhone();
    if (!phone) return;
    const codeInput = this.root?.querySelector('#auth-code');
    const code = codeInput?.value.trim() || '';
    if (!code) {
      this.setMessage('请输入短信验证码。', 'error');
      codeInput?.focus();
      return;
    }
    this.setMessage('');
    this.setBusy(true, '验证中…');
    try {
      await verifyPhoneOtp(phone, code);
      this.clearCooldown();
      this.showSyncing('验证成功，正在加载你的错题本…');
    } catch (error) {
      this.setBusy(false);
      this.setMessage(formatAuthError(error, '登录失败，请检查验证码后重试。'), 'error');
    }
  }

  async handleOAuth(provider) {
    const label = provider === 'wechat' ? '微信' : 'QQ';
    this.setMessage('');
    this.setBusy(true, '正在打开…');
    try {
      const result = await startThirdPartyLogin(provider);
      if (result.native) {
        this.setBusy(false);
        this.setMessage(`已打开${label}授权页面，请在浏览器中完成授权，完成后会自动返回知隙。`, 'success');
      } else {
        this.setMessage(`正在前往${label}授权页面…`, 'info');
      }
    } catch (error) {
      this.setBusy(false);
      this.setMessage(formatAuthError(error, `${label}登录未能启动，请稍后重试或使用手机号登录。`), 'error');
    }
  }
}
