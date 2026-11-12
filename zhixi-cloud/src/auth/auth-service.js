import {
  supabase,
  requireSupabase,
  isSupabaseConfigured,
  configError,
  OAUTH_BRIDGE_BASE_URL,
  getWebRedirectUrl
} from '../lib/supabase.js';
import { getOAuthRedirectTarget, openExternalUrl, isNativeApp } from '../lib/platform.js';

const processedTokens = new Set();

export function getAuthConfigState() {
  return { configured: isSupabaseConfigured, error: configError };
}

export function normalizePhone(input) {
  const raw = String(input || '').trim().replace(/[\s()-]/g, '');
  if (!raw) return null;
  let digits = raw.replace(/^\+/, '').replace(/\D/g, '');
  if (!digits) return null;
  // 默认面向中国大陆手机号：11 位 1 开头自动补 +86。
  if (!raw.startsWith('+') && /^1\d{10}$/.test(digits)) digits = `86${digits}`;
  if (digits.startsWith('0086')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 11) return `+${digits.slice(0, 2)} ${digits.slice(2, 5)}****${digits.slice(-4)}`;
  return phone;
}

export function formatAuthError(error, fallback = '操作没有完成，请稍后重试。') {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return fallback;
  if (message.includes('rate limit') || message.includes('security purposes')) {
    return '操作太频繁，请稍等一会儿再试。';
  }
  if (message.includes('invalid phone') || message.includes('phone number')) {
    return '手机号格式不正确，请使用 E.164 格式或 11 位中国大陆手机号。';
  }
  if (message.includes('token has expired') || message.includes('expired')) {
    return '验证码已过期，请重新获取。';
  }
  if (message.includes('invalid token') || message.includes('invalid otp') || message.includes('otp')) {
    return '验证码不正确，请检查后重试。';
  }
  if (message.includes('not found')) {
    return '账号不存在或登录状态失效，请重新登录。';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return '网络连接失败，请检查网络后重试。';
  }
  if (message.includes('provider') && message.includes('not enabled')) {
    return '该登录方式尚未启用，请联系站点管理员。';
  }
  if (message.includes('captcha')) {
    return '当前项目启用了人机验证，请完成验证后再试。';
  }
  return fallback;
}

export async function requestPhoneOtp(phoneInput) {
  const client = requireSupabase();
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error('请输入正确的手机号。');
  const { error } = await client.auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: true }
  });
  if (error) throw error;
  return phone;
}

export async function verifyPhoneOtp(phoneInput, token) {
  const client = requireSupabase();
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error('请输入正确的手机号。');
  const cleaned = String(token || '').replace(/\D/g, '');
  if (cleaned.length < 4) throw new Error('请输入短信验证码。');
  const { data, error } = await client.auth.verifyOtp({
    phone,
    token: cleaned,
    type: 'sms'
  });
  if (error) throw error;
  return data.session;
}

export function buildOAuthStartUrl(provider) {
  if (!OAUTH_BRIDGE_BASE_URL) {
    throw new Error('缺少 VITE_OAUTH_BRIDGE_BASE_URL，无法开始第三方登录。');
  }
  if (!['wechat', 'qq'].includes(provider)) throw new Error('不支持的登录方式。');
  const start = new URL(`${OAUTH_BRIDGE_BASE_URL}/start`);
  const redirectTo = isNativeApp() ? getOAuthRedirectTarget() : getWebRedirectUrl();
  start.searchParams.set('provider', provider);
  start.searchParams.set('redirect_to', redirectTo);
  return start.toString();
}

export async function startThirdPartyLogin(provider) {
  requireSupabase();
  const url = buildOAuthStartUrl(provider);
  await openExternalUrl(url);
  return { url, native: isNativeApp() };
}

export async function verifyMagicLinkToken(tokenHash, type = 'email') {
  const client = requireSupabase();
  if (!tokenHash) throw new Error('登录链接缺少 token。');
  if (processedTokens.has(tokenHash)) {
    throw new Error('该登录链接已经使用过，请重新发起登录。');
  }
  processedTokens.add(tokenHash);
  const verificationType = type === 'magiclink' ? 'email' : type;
  try {
    const { data, error } = await client.auth.verifyOtp({
      token_hash: tokenHash,
      type: verificationType || 'email'
    });
    if (error) throw error;
    return data.session;
  } catch (error) {
    // token 只能被服务端消费一次；本地失败（如断网）时允许刷新后重试。
    processedTokens.delete(tokenHash);
    throw error;
  }
}

function readUrlParams(rawUrl) {
  const url = new URL(rawUrl, window.location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const get = (key) => url.searchParams.get(key) || hashParams.get(key) || '';
  return {
    url,
    tokenHash: get('token_hash'),
    type: get('type') || 'email',
    authError: get('auth_error') || get('error_description') || get('error'),
    providerError: get('provider_error')
  };
}

function cleanWebAuthParams(url) {
  if (isNativeApp()) return;
  try {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const clean = new URL(window.location.href);
    ['token_hash', 'type', 'provider', 'auth_error', 'provider_error', 'error', 'error_description', 'error_code']
      .forEach((key) => clean.searchParams.delete(key));
    window.history.replaceState({}, document.title, `${clean.pathname}${clean.search}${clean.hash}`);
  } catch {
    // 清 URL 失败不应阻断登录。
  }
}

/**
 * 处理 Web 回跳或原生 deep link。
 * 返回 { handled, session?, error? }。
 */
export async function consumeAuthReturnUrl(rawUrl) {
  if (!rawUrl) return { handled: false };
  let params;
  try {
    params = readUrlParams(rawUrl);
  } catch {
    return { handled: false };
  }
  if (params.authError) {
    let authError = params.authError;
    try {
      authError = decodeURIComponent(authError).replace(/\+/g, ' ');
    } catch {
      // 保留原始文本
    }
    cleanWebAuthParams(params.url);
    return { handled: true, error: authError };
  }
  if (!params.tokenHash) return { handled: false };

  try {
    const session = await verifyMagicLinkToken(params.tokenHash, params.type);
    cleanWebAuthParams(params.url);
    return { handled: true, session };
  } catch (error) {
    cleanWebAuthParams(params.url);
    const message = formatAuthError(error, '第三方登录链接已失效，请重新登录。');
    return { handled: true, error: message };
  }
}

export async function getSession() {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  if (!supabase) return;
  // 只退出当前设备，不影响同一账号的其他设备。
  await supabase.auth.signOut({ scope: 'local' });
}

export function onAuthStateChange(callback) {
  const client = requireSupabase();
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    // Supabase 文档建议：onAuthStateChange 内不要直接 await 其他 auth 方法。
    window.setTimeout(() => callback(event, session), 0);
  });
  return () => subscription?.unsubscribe();
}

export function getCurrentUserLabel(user) {
  if (!user) return '知隙用户';
  const metadata = user.user_metadata || {};
  if (metadata.display_name) return String(metadata.display_name);
  if (user.phone) return maskPhone(user.phone);
  if (metadata.oauth_provider_label) return `${metadata.oauth_provider_label}用户`;
  return user.email ? String(user.email).split('@')[0] : '知隙用户';
}
