// main.js —— DSH Web GUI 的 Electron 宿主（完整版）
// 渲染内核：Electron 内置 Chromium；服务：本机 nvm 的 node 跑 dsh web。
'use strict';

const { app, BrowserWindow, Menu, Tray, shell, session, nativeImage, screen } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SVC = require('./service');

// ---------------- 自检开关 ----------------
if (process.env.DSH_EL_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9333');
}
const SELFTEST = process.env.DSH_EL_SELFTEST || '';

// ---------------- 配置 ----------------

function readConfigFile() {
  const file = path.join(os.homedir(), '.dsh', 'mac-launcher.yaml');
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    }
  } catch (e) { /* 没有配置文件就用默认 */ }
  return out;
}

const env = process.env;
const fileCfg = readConfigFile();
function cfgValue(key, fallback) {
  if (env[key] && env[key].length) return env[key];
  if (fileCfg[key] && fileCfg[key].length) return fileCfg[key];
  return fallback;
}
function cfgBool(key, fallback) {
  const v = String(cfgValue(key, fallback ? '1' : '0')).toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}
function cfgNum(key, fallback) {
  const n = Number(cfgValue(key, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

const PORT = cfgNum('DSH_WEB_PORT', 3080);
const ROOT_URL = 'http://127.0.0.1:' + PORT + '/';
const LOG_DIR = cfgValue('DSH_LOG_DIR', path.join(os.homedir(), 'Library/Logs/DSH'));
const WORKDIR = cfgValue('DSH_WORKDIR', os.homedir());
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const OVERLAY = path.join(__dirname, 'overlay.html');
const SHOW_OVERLAY = cfgBool('DSH_STARTUP_OVERLAY', true);
const TRAY_ENABLED = cfgBool('DSH_TRAY', true);
const OPEN_ON_LAUNCH = cfgBool('DSH_OPEN_WINDOW', true);

const cfg = {
  port: PORT,
  dshBin: cfgValue('DSH_BIN', SVC.defaultDshBin()),
  workdir: (WORKDIR.charAt(0) === '~') ? path.join(os.homedir(), WORKDIR.slice(1)) : WORKDIR,
  serviceReadyTimeout: cfgNum('DSH_SERVICE_TIMEOUT', 60),
  tokenTimeout: cfgNum('DSH_TOKEN_TIMEOUT', 20),
  stopTimeout: cfgNum('DSH_STOP_TIMEOUT', 10),
  logDirectory: LOG_DIR,
  logPath: path.join(LOG_DIR, 'electron-launcher.log'),
  serviceLogPath: path.join(LOG_DIR, 'service.log'),
  serviceRawLogPath: path.join(LOG_DIR, 'service-raw.log'),
  authCachePath: path.join(LOG_DIR, 'auth-url'),
  serviceStatePath: path.join(LOG_DIR, 'service-state.json'),
  authLogCandidates: [
    path.join(LOG_DIR, 'service-raw.log'),
    path.join(LOG_DIR, 'service.log'),
    path.join(os.homedir(), 'dsh', 'dsh-launcher', 'dsh-web.log'),
    path.join(os.homedir(), 'dsh-launcher', 'dsh-web.log'),
    path.join(LOG_DIR, 'dsh-web.log')
  ],
  forwardArgs: []
};

// ---------------- 日志 ----------------

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + SVC.redact(msg) + '\n';
  process.stdout.write(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(cfg.logPath, line, { mode: 0o600 });
  } catch (e) { /* 忽略 */ }
}

// ---------------- 运行时状态 ----------------

const service = new SVC.ServiceController(cfg);
let win = null;
let tray = null;
let overlayVisible = false;
let overlayStartedAt = Date.now();
let progressTimer = null;
let connectionRetries = 0;
let authRetries = 0;
let lastAttempted = null;
let readyLogged = false;
let restartingUi = false;
let zoomLogged = false;
let titleSuppressed = false;

// ---------------- 窗口状态 ----------------

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function writeState(patch) {
  try {
    const cur = readState() || {};
    Object.assign(cur, patch);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cur));
  } catch (e) { /* 忽略 */ }
}
function clampZoom(v) { return Math.min(Math.max(v, 0.5), 3.0); }

// Swift 宿主把用户调过的缩放记在 UserDefaults 的 pageZoom 里（键名就是 pageZoom）。
// 读它，Electron 版首次运行才能和主人现有的 120% 观感一致。
function swiftHostZoom() {
  try {
    const out = execFileSync('/usr/bin/defaults',
      ['read', 'com.kaidiren.dsh-mac-launcher', 'pageZoom'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const v = Number(String(out).trim());
    if (Number.isFinite(v) && v >= 0.5 && v <= 3.0) return v;
  } catch (e) { /* 读不到就算了 */ }
  return null;
}

// 回退链：自己的状态 → DSH_PAGE_ZOOM 配置 → Swift 宿主记录的值 → 100%
function currentZoom() {
  const st = readState();
  if (st && typeof st.zoom === 'number') return clampZoom(st.zoom);

  const raw = cfgValue('DSH_PAGE_ZOOM', '');
  const fromCfg = raw === '' ? NaN : Number(raw);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return clampZoom(fromCfg);

  const fromSwift = swiftHostZoom();
  if (fromSwift !== null) return clampZoom(fromSwift);

  return 1.0;
}

// quiet = 加载后对齐用：不写状态、不打日志（每次导航都会调一次）
function setZoom(factor, quiet) {
  if (!win || win.isDestroyed()) return;
  const v = clampZoom(factor);
  win.webContents.setZoomFactor(v);
  if (!quiet) {
    writeState({ zoom: v });
    log('页面缩放：' + Math.round(v * 100) + '%');
  }
}

function applyZoom(factor) { setZoom(factor, false); }

// ---------------- 遮罩 ----------------

function showOverlay(message, detail) {
  if (!win || win.isDestroyed()) return;
  if (!SHOW_OVERLAY) return;
  overlayVisible = true;
  overlayStartedAt = Date.now();
  win.loadFile(OVERLAY).then(() => {
    updateOverlay(message, detail);
  }).catch(() => {});
  startProgressTicker();
}

function updateOverlay(message, detail) {
  if (!win || win.isDestroyed() || !overlayVisible) return;
  const payload = 'window.__dshSet(' + JSON.stringify(String(message || '')) + ',' + JSON.stringify(String(detail || '')) + ')';
  win.webContents.executeJavaScript(payload).catch(() => {});
}

function startProgressTicker() {
  stopProgressTicker();
  progressTimer = setInterval(() => {
    if (!overlayVisible) return;
    const elapsed = Math.round((Date.now() - overlayStartedAt) / 1000);
    updateOverlay(service.label(), service.stateDetail || ('已用 ' + elapsed + ' 秒'));
  }, 500);
}

function stopProgressTicker() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function hideOverlay() {
  overlayVisible = false;
  stopProgressTicker();
}

// ---------------- 加载 ----------------

function ownURL(url) {
  if (!url) return false;
  const m = String(url).match(/^https?:\/\/([^\/:]+|\[[^\]]+\]):(\d+)/);
  if (!m) return false;
  return Number(m[2]) === PORT;
}

function openExternal(url) {
  try {
    const u = new URL(url);
    log('链接交给系统浏览器：' + u.host + (u.pathname || '/'));
    shell.openExternal(url);
  } catch (e) { /* 忽略 */ }
}

function loadHome() {
  if (!win || win.isDestroyed()) return;
  hideOverlay();
  const target = service.currentAuthURL() || ROOT_URL;
  if (target !== ROOT_URL && target === lastAttempted) {
    log('该认证地址已试过，改走 cookie 裸加载');
    win.loadURL(ROOT_URL);
    return;
  }
  if (target !== ROOT_URL) lastAttempted = target;
  log('加载界面：' + (target.indexOf('token=') >= 0 ? '（含 token，已隐去）' : target));
  win.loadURL(target);
}

async function checkReady(attempt) {
  if (!win || win.isDestroyed() || overlayVisible) return;
  let raw;
  try {
    raw = await win.webContents.executeJavaScript(
      'JSON.stringify({' +
      '  title: document.title,' +
      '  textLen: document.body ? document.body.innerText.length : -1,' +
      '  head: document.body ? document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 80) : "",' +
      '  scrollW: document.documentElement.scrollWidth,' +
      '  clientW: document.documentElement.clientWidth,' +
      '  scrollH: document.documentElement.scrollHeight,' +
      '  clientH: document.documentElement.clientHeight,' +
      '  dpr: window.devicePixelRatio,' +
      '  nodes: document.querySelectorAll("*").length,' +
      '  fonts: (function(){ try { return document.fonts.size; } catch(e){ return -1; } })()' +
      '})'
    );
  } catch (e) { return; }
  if (!raw) return;

  let info;
  try { info = JSON.parse(raw); } catch (e) { return; }

  if (info.textLen >= 0 && info.head.indexOf('authentication required') >= 0) {
    await handleAuthWall();
    return;
  }

  if (info.textLen > 200) {
    if (!readyLogged) {
      readyLogged = true;
      authRetries = 0;
      connectionRetries = 0;
      log('[verify] ' + raw);
      log('界面就绪（' + info.textLen + ' 字符）');
    }
    return;
  }
  if (attempt >= 20) {
    if (!readyLogged) {
      readyLogged = true;
      log('[verify] ' + raw);
      log('就绪判定超时，仍按当前状态展示');
    }
    return;
  }
  const interval = Math.min(200 * attempt, 1200);
  setTimeout(() => checkReady(attempt + 1), interval);
}

async function handleAuthWall() {
  authRetries++;
  if (authRetries > 3) {
    log('认证墙连续 ' + authRetries + ' 次未通过，停止重试');
    showOverlay('认证失败', '服务端要求认证，且拿不到新的认证地址。请在菜单里「重启服务」重试。');
    return;
  }
  log('检测到认证墙（第 ' + authRetries + ' 次），尝试重新认证');

  const fromLog = service.recoverTokenFromLog();
  const candidate = fromLog || service.currentAuthURL();
  if (candidate && candidate !== lastAttempted) {
    lastAttempted = candidate;
    log('用已知认证地址重新加载');
    win.loadURL(candidate);
    return;
  }

  if (!service.ownsProcess && service.isOurOrphanedService()) {
    showOverlay('正在接管遗留服务…');
    try {
      await service.takeOverOrphanedService();
      loadHome();
    } catch (e) {
      log('接管失败：' + e.message);
      showOverlay('接管失败', e.message);
    }
    return;
  }

  if (!service.ownsProcess) {
    log('服务不是本宿主启动的，且拿不到认证地址；不擅自重启它');
    showOverlay('无法认证', '端口 ' + PORT + ' 上的服务不是本宿主启动的。可在终端打开 dsh 打印的认证地址完成一次认证，或用菜单「重启服务」强制重启它。');
    return;
  }

  showOverlay('正在重新认证…', '重启服务以取得新 token');
  try {
    await service.restart();
    authRetries = 0;
    lastAttempted = null;
    loadHome();
  } catch (e) {
    log('重启失败：' + e.message);
    showOverlay('启动失败', e.message);
  }
}

// ---------------- 启动流程 ----------------

async function bootstrap() {
  // 热路径：服务已在监听 → 直接加载真实页面，不加载遮罩页（省一次导航与两段闪烁）
  if (await service.isListening()) {
    log('端口 ' + PORT + ' 上已有服务，复用（跳过遮罩）');
    service.setState(SVC.STATE.READY);
    loadHome();
    return;
  }

  // 冷路径：需要拉起服务，这要 2 秒左右，此时才值得上遮罩
  showOverlay('正在检查服务…');
  log('端口 ' + PORT + ' 无服务，拉起 dsh web');
  try {
    await service.startIfNeeded();
  } catch (e) {
    log('启动失败：' + e.message);
    showOverlay('启动失败', e.message);
    return;
  }
  loadHome();
}

// ---------------- 菜单 ----------------

function buildMenu() {
  const running = service.isRunning;
  const busy = service.isBusy;

  const template = [
    {
      label: 'DSH',
      submenu: [
        { role: 'about', label: '关于 DSH' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 DSH' },
        { type: 'separator' },
        { role: 'quit', label: '退出 DSH' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { label: '放大', accelerator: 'CommandOrControl+Plus', click: () => applyZoom(currentZoom() + 0.1) },
        { label: '缩小', accelerator: 'CommandOrControl+-', click: () => applyZoom(currentZoom() - 0.1) },
        { label: '实际大小', accelerator: 'CommandOrControl+0', click: () => applyZoom(1.0) },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'Alt+Command+I', click: () => win && win.webContents.toggleDevTools() }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'close', label: '关闭窗口' },
        {
          label: '刷新',
          accelerator: 'CommandOrControl+R',
          enabled: running,
          click: () => { if (win) { readyLogged = false; win.webContents.reload(); } }
        },
        {
          label: '重启服务',
          accelerator: 'Shift+CommandOrControl+R',
          enabled: !busy && !restartingUi,
          click: () => restartService()
        },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  if (!TRAY_ENABLED) return;
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate@2x.png');
  let image = null;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (!image || image.isEmpty()) image = null;
    else { image = image.resize({ width: 18, height: 18 }); image.setTemplateImage(true); }
  } catch (e) { image = null; }
  if (!image) { log('托盘图标缺失，跳过托盘'); return; }

  if (!tray) {
    tray = new Tray(image);
    tray.on('click', () => showWindow());
  }
  tray.setImage(image);
  tray.setToolTip('DSH ' + service.label() + '（端口 ' + PORT + '）');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'DSH · ' + service.label() + '（端口 ' + PORT + '）', enabled: false },
    { type: 'separator' },
    { label: '打开', accelerator: 'CommandOrControl+O', click: () => showWindow() },
    { label: '刷新', accelerator: 'CommandOrControl+R', enabled: service.isRunning, click: () => { if (win) { zoomLogged = false; readyLogged = false; win.webContents.reload(); } } },
    { type: 'separator' },
    { label: '重启服务', accelerator: 'Shift+CommandOrControl+R', enabled: !service.isBusy, click: () => restartService() },
    { label: '退出', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ]));
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  createWindow();
  if (readyLogged) win.loadURL(service.currentAuthURL() || ROOT_URL);
  else bootstrap();
}

// ---------------- 动作 ----------------

async function restartService() {
  if (restartingUi || service.isBusy) { log('重启已在进行中，忽略'); return; }
  restartingUi = true;
  readyLogged = false;
  authRetries = 0;
  lastAttempted = null;
  try {
    log('菜单：重启服务' + (service.ownsProcess ? '' : '（服务非本宿主启动，将强制停止后重新拉起）'));
    showOverlay('正在重启服务…');
    await service.restart();
    loadHome();
  } catch (e) {
    log('重启失败：' + e.message);
    showOverlay('启动失败', e.message);
  } finally {
    restartingUi = false;
  }
}

// ---------------- 窗口 ----------------

function createWindow() {
  const st = readState() || {};
  const mode = String(cfgValue('DSH_WINDOW_MODE', 'maximized')).toLowerCase();
  const remember = cfgBool('DSH_REMEMBER_WINDOW_SIZE', true);

  let bounds;
  if (mode === 'custom') {
    bounds = {
      width: (remember && st.width) || cfgNum('DSH_WINDOW_WIDTH', 1180),
      height: (remember && st.height) || cfgNum('DSH_WINDOW_HEIGHT', 800)
    };
    if (remember && st.x !== undefined) bounds.x = st.x;
    if (remember && st.y !== undefined) bounds.y = st.y;
  } else {
    // 默认占满屏幕可用区域（与 Swift 壳的 .maximized 一致）
    const area = screen.getPrimaryDisplay().workArea;
    bounds = { x: area.x, y: area.y, width: area.width, height: area.height };
  }

  win = new BrowserWindow(Object.assign({
    minWidth: 640,
    minHeight: 460,
    title: '',            // 标题栏留空，什么都不显示
    backgroundColor: '#ffffff',
    show: false,          // 等首帧渲染好再显示，避免白色空窗一闪
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  }, bounds));

  win.on('resize', () => writeState(win.getBounds()));
  win.on('move', () => writeState(win.getBounds()));
  win.on('close', () => writeState(win.getBounds()));
  win.on('closed', () => { win = null; });

  win.webContents.on('will-navigate', (event, url) => {
    if (!ownURL(url)) { event.preventDefault(); openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ownURL(url)) { win.loadURL(url); return { action: 'deny' }; }
    openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('context-menu', (event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'cut', label: '剪切' });
      items.push({ role: 'copy', label: '拷贝' });
      items.push({ role: 'paste', label: '粘贴' });
      items.push({ type: 'separator' });
    }
    items.push({ label: '刷新', enabled: service.isRunning, click: () => { readyLogged = false; win.webContents.reload(); } });
    items.push({ label: '回到主页', click: () => loadHome() });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (url && url.indexOf('file://') === 0) return;
    connectionRetries++;
    if (connectionRetries > 15) {
      log('连接服务失败已达 15 次，停止重试');
      showOverlay('无法连接服务', '请确认 dsh web 正在运行，然后在菜单里「重启服务」。');
      return;
    }
    log('加载失败 code=' + code + ' ' + desc + '（第 ' + connectionRetries + ' 次重试）');
    showOverlay('正在连接服务…', '第 ' + connectionRetries + '/15 次尝试');
    setTimeout(() => { if (!overlayVisible) return; loadHome(); }, 1000);
  });

  // 缩放按 origin 记：导航提交后（did-navigate）就设，能在首次布局之前生效，
  // 避免「先按 100% 排好、再跳到 120%」的那次重排。did-finish-load 只作兜底。
  win.webContents.on('did-navigate', (e, url) => {
    if (!ownURL(url)) return;
    const z = currentZoom();
    setZoom(z, true);
    if (!zoomLogged) {
      zoomLogged = true;
      log('页面缩放：' + Math.round(z * 100) + '%（导航提交时应用）');
    }
  });

  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    if (url && url.indexOf('file://') === 0) return;   // 遮罩页不参与
    setZoom(currentZoom(), true);                       // 兜底
    setTimeout(() => checkReady(1), 120);
  });
  // 标题栏保持空白：拦掉页面标题自动写入，并显式清空一次
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    if (win && !win.isDestroyed()) win.setTitle('');
    if (!titleSuppressed) {
      titleSuppressed = true;
      log('标题栏保持空白（已拦下页面标题写入）');
    }
  });

  win.once('ready-to-show', () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    setZoom(currentZoom(), true);
  });
}

function setupDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    const dir = app.getPath('downloads');
    const name = item.getFilename() || 'download';
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let target = path.join(dir, name);
    let i = 2;
    while (fs.existsSync(target)) { target = path.join(dir, base + ' ' + i + ext); i++; }
    item.setSavePath(target);
    log('下载到 ' + target);
    item.once('done', (e, state) => log('下载结束 ' + state));
  });
}

// ---------------- 状态联动 ----------------

service.on('state', () => {
  buildMenu();
  buildTray();
  if (overlayVisible) updateOverlay(service.label(), service.stateDetail || '');
});
service.on('log', (msg) => log(msg));
service.on('auth', (url) => SVC.AuthCache.write(cfg.authCachePath, url));

// ---------------- 生命周期 ----------------

app.setAboutPanelOptions({
  applicationName: 'DSH',
  applicationVersion: app.getVersion(),
  version: '',
  copyright: 'DSH Web GUI · Electron 宿主（Chromium 渲染内核）'
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    log('Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome +
      '（端口 ' + PORT + '，dsh=' + cfg.dshBin + '）');
    buildMenu();
    setupDownloads();
    createWindow();

    if (OPEN_ON_LAUNCH) {
      await bootstrap();
    } else {
      log('按配置不自动开窗（DSH_OPEN_WINDOW=0）');
    }
    buildTray();

    if (SELFTEST === 'restart') {
      setTimeout(async () => {
        log('自省：触发重启');
        await restartService();
        log('自省：重启完成，状态=' + service.state);
        setTimeout(() => { log('自省：结束'); app.quit(); }, 3000);
      }, 4000);
    } else if (SELFTEST === 'orphan') {
      const record = service.loadServiceRecord();
      log('自省：服务记录=' + (record ? JSON.stringify(record) : '无'));
      log('自省：端口监听者=' + SVC.listeningPIDs(PORT).join(','));
      log('自省：判定为本宿主的残留进程=' + (service.isOurOrphanedService() ? '是' : '否'));
      setTimeout(() => { log('自省：结束'); app.quit(); }, 1500);
    } else if (SELFTEST === 'close') {
      setTimeout(() => {
        log('自省：关闭窗口');
        if (win) win.close();
        setTimeout(() => {
          log('自省：关窗后 窗口已关=' + (win === null ? '是' : '否') + ' 服务仍在监听=' + (service.isRunning ? '是' : '否'));
          app.quit();
        }, 2000);
      }, 5000);
    }
  });

  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { /* 关窗不退应用 */ });

  app.on('before-quit', async (event) => {
    if (service.ownsProcess) {
      event.preventDefault();
      log('开始退出：停服务');
      await service.stop(false);
      log('已退出');
      app.exit(0);
    }
  });
}
