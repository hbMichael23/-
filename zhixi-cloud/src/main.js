// 保持 Tailwind utilities 在 legacy.css 之后输出，与原始 CDN 渲染的层叠顺序一致。
// 例如 .field 的 width 需要让位于 select.w-auto 等工具类。
import './styles/legacy.css';
import './styles/tailwind.css';
import './styles/cloud.css';
import './app/app.js';

import { isSupabaseConfigured, configError } from './lib/supabase.js';
import {
  consumeAuthReturnUrl,
  getSession,
  onAuthStateChange,
  signOut
} from './auth/auth-service.js';
import { getInitialDeepLink, listenForAuthDeepLinks, saveTextFile } from './lib/platform.js';
import { CloudSync } from './cloud/cloud-sync.js';
import { CloudUI } from './cloud/cloud-ui.js';
import { AuthUI } from './auth/auth-ui.js';

// MathJax 的配置必须在动态 <script> 加载前存在。
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true
  },
  svg: { fontCache: 'global' },
  options: {
    skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    enableMenu: false
  }
};

const App = window.ZhixiApp;
if (!App) {
  throw new Error('知隙应用初始化失败：找不到 window.ZhixiApp');
}

const authUI = new AuthUI();
const cloudUI = new CloudUI();
window.ZhixiCloudUI = cloudUI;
window.ZhixiCloud = CloudSync;
// App.js 的导出函数会优先使用它；Web 端返回 null，自动回退到原 Blob 下载。
// 不在模块加载时判断 isNativeApp：原生壳初始化脚本的注入时机可能更晚。
window.ZhixiSaveBackup = saveTextFile;
let appStarted = false;
let bootPromise = null;
let authErrorFromUrl = '';
let authSubscription = null;
const processedDeepLinks = new Set();

authUI.init();
cloudUI.init({
  app: App,
  onSignOut: async () => {
    try {
      CloudSync.detach();
      await signOut();
    } finally {
      window.location.reload();
    }
  }
});

function showApp() {
  document.body.classList.add('app-ready');
  authUI.hide();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

async function bootSignedInUser(session) {

  if (!session?.user) return;
  if (appStarted) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    const user = session.user;
    authUI.showSyncing('正在加载你的错题本…');
    cloudUI.setUser(user);

    const localState = App.readStateFromStorage(App.getScopedStorageKey(user.id));
    const prepared = await CloudSync.bootstrap({
      user,
      app: App,
      localState
    });

    const booted = App.boot({
      initialState: prepared.state,
      storageKey: App.getScopedStorageKey(user.id),
      notices: prepared.notices,
      onCommit: (previousState, nextState) => {
        CloudSync.handleLocalCommit(previousState, nextState);
      }
    });

    if (!booted && !App.isBooted()) {
      throw new Error('错题本初始化失败，请刷新页面重试。');
    }

    appStarted = true;
    showApp();
    cloudUI.setUser(user);
    CloudSync.attach();
    cloudUI.refreshCard();
  })().catch((error) => {
    console.error('登录后初始化失败', error);
    appStarted = false;
    bootPromise = null;
    document.body.classList.remove('app-ready');
    authUI.showLogin({
      error: error?.message || '登录成功，但错题本加载失败，请刷新页面重试。'
    });
  });

  return bootPromise;
}

async function handleAuthUrl(rawUrl, { initial = false } = {}) {
  if (!rawUrl) return false;
  if (appStarted) return false;
  if (processedDeepLinks.has(rawUrl)) return false;
  processedDeepLinks.add(rawUrl);
  authUI.showLoading(initial ? '正在读取登录信息…' : '正在验证第三方登录…');
  const result = await consumeAuthReturnUrl(rawUrl);
  if (result.error) {
    authErrorFromUrl = result.error;
    authUI.showLogin({ error: result.error });
    return true;
  }
  if (result.session) {
    await bootSignedInUser(result.session);
    return true;
  }
  return result.handled;
}

async function initializeAuth() {
  if (!isSupabaseConfigured) {
    authUI.showConfigError();
    return;
  }

  authSubscription = onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
      if (session?.user) {
        void bootSignedInUser(session);
      } else if (event === 'INITIAL_SESSION' && !appStarted) {
        // 交给 getSession / OAuth 返回流程显示登录页。
      }
    } else if (event === 'SIGNED_OUT') {
      if (appStarted) {
        CloudSync.detach();
        window.location.reload();
      }
    }
  });

  await listenForAuthDeepLinks((url) => {
    void handleAuthUrl(url, { initial: false });
  });

  const initialDeepLink = await getInitialDeepLink();
  if (initialDeepLink) {
    await handleAuthUrl(initialDeepLink, { initial: true });
  }

  // Web OAuth 回跳 / 第三方登录错误都在当前 URL 的 query 中。
  if (window.location.search) {
    await handleAuthUrl(window.location.href, { initial: true });
  }

  let session = null;
  try {
    session = await getSession();
  } catch (error) {
    console.warn('读取登录会话失败', error);
  }

  if (session?.user) {
    await bootSignedInUser(session);
    return;
  }

  if (authErrorFromUrl) {
    authUI.showLogin({ error: authErrorFromUrl });
  } else {
    authUI.showLogin();
  }
}

void initializeAuth().catch((error) => {
  console.error('初始化登录失败', error);
  if (isSupabaseConfigured) {
    authUI.showLogin({ error: configError || '登录服务初始化失败，请刷新页面重试。' });
  } else {
    authUI.showConfigError();
  }
});

// 供调试和原生壳集成时检查（不暴露敏感配置）。
window.ZhixiCloudApp = {
  get started() { return appStarted; },
  authUI,
  cloudUI,
  cloudSync: CloudSync
};

window.addEventListener('beforeunload', () => {
  authSubscription?.();
});
