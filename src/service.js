// service.js —— `dsh web` 服务的生命周期管理（对齐 Swift 的 ServiceController）
// 只做服务：状态机、拉起、等端口、解析 token、重启、停止、残留进程接管、按端口强杀。
'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// ---------------- token 解析 ----------------

function authPatternSource(port) {
  return 'https?://[^\\s"\']*?:' + port + '/\\?token=[A-Za-z0-9_.\\-]+';
}

function firstAuthURL(text, port) {
  const m = text.match(new RegExp(authPatternSource(port)));
  return m ? m[0] : null;
}

function lastAuthURL(text, port) {
  const all = text.match(new RegExp(authPatternSource(port), 'g'));
  return all && all.length ? all[all.length - 1] : null;
}

// 增量扫描器：流式喂入输出，命中一次后即返回
class AuthScanner {
  constructor(port) {
    this.port = port;
    this.buffer = '';
    this.url = null;
  }
  feed(chunk) {
    if (this.url) return this.url;
    this.buffer += chunk;
    if (this.buffer.length > 64000) this.buffer = this.buffer.slice(-16000);
    const found = firstAuthURL(this.buffer, this.port);
    if (found) this.url = found;
    return found;
  }
}

// 认证地址缓存（0600，里面是 token）
const AuthCache = {
  read(file) {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      return v || null;
    } catch (e) { return null; }
  },
  write(file, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (e) { /* 忽略 */ }
  },
  clear(file) {
    try { fs.unlinkSync(file); } catch (e) { /* 忽略 */ }
  }
};

// 落盘前把 token 抹掉（service.log 可以放心外发）
function redact(text) {
  return String(text).replace(/token=[A-Za-z0-9_.%\-]+/g, 'token=<REDACTED>');
}

// ---------------- 端口探测 ----------------

function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port: port, host: '127.0.0.1' });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.setTimeout(800, () => finish(false));
  });
}

// 端口上的监听进程（lsof；读不到就返回空）
function listeningPIDs(port) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/[\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  } catch (e) { return []; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- 服务控制器 ----------------

const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  WAITING_PORT: 'waitingPort',
  READY: 'ready',
  EXITED: 'exited',
  FAILED: 'failed'
};

class ServiceController extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.state = STATE.IDLE;
    this.stateDetail = '';
    this.process = null;
    this.authURL = AuthCache.read(cfg.authCachePath);
    this.scanner = new AuthScanner(cfg.port);
    this.restarting = false;
    this.exitedEarly = false;
    this.recentOutput = [];
    this.rawStream = null;
    this.svcStream = null;
  }

  get ownsProcess() { return this.process !== null; }
  get isBusy() { return this.state === STATE.STARTING || this.state === STATE.WAITING_PORT; }
  get isRunning() { return this.state === STATE.READY; }

  label() {
    switch (this.state) {
      case STATE.IDLE: return '未运行';
      case STATE.STARTING: return '正在启动服务…';
      case STATE.WAITING_PORT: return '等待服务就绪…';
      case STATE.READY: return '运行中';
      case STATE.EXITED: return '服务已退出（pid ' + this.stateDetail + '）';
      case STATE.FAILED: return '启动失败：' + this.stateDetail;
      default: return this.state;
    }
  }

  setState(state, detail) {
    const d = detail === undefined ? '' : String(detail);
    if (this.state === state && this.stateDetail === d) return;
    this.state = state;
    this.stateDetail = d;
    this.emit('state', this);
  }

  async isListening() { return portListening(this.cfg.port); }

  // ---- 认证地址 ----

  currentAuthURL() { return this.authURL; }

  recoverTokenFromLog() {
    for (const file of this.cfg.authLogCandidates) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      const found = lastAuthURL(text, this.cfg.port);
      if (!found) continue;
      this.authURL = found;
      AuthCache.write(this.cfg.authCachePath, found);
      this.emit('log', '已从日志恢复认证地址（' + path.basename(file) + '）');
      return found;
    }
    this.emit('log', '未能在日志里找到认证地址');
    return null;
  }

  // ---- 启动 ----

  async startIfNeeded() {
    let waited = 0;
    while (this.restarting && waited < 400) { await sleep(100); waited++; }
    if (this.restarting) throw new Error('等待重启超时');

    if (await this.isListening()) {
      this.emit('log', '服务已在运行（端口 ' + this.cfg.port + ' 有监听），复用现有进程');
      this.setState(STATE.READY);
      return;
    }
    await this.launch();
  }

  async launch() {
    const bin = this.cfg.dshBin;
    let executable = false;
    try { fs.accessSync(bin, fs.constants.X_OK); executable = true; } catch (e) { executable = false; }
    if (!executable) {
      this.setState(STATE.FAILED, '找不到 dsh');
      throw new Error('找不到可执行的 dsh（DSH_BIN=' + bin + '）');
    }

    this.setState(STATE.STARTING);
    this.exitedEarly = false;
    this.recentOutput = [];
    this.scanner = new AuthScanner(this.cfg.port);

    fs.mkdirSync(this.cfg.logDirectory, { recursive: true });
    this.rawStream = fs.createWriteStream(this.cfg.serviceRawLogPath, { flags: 'a', mode: 0o600 });
    try { fs.chmodSync(this.cfg.serviceRawLogPath, 0o600); } catch (e) {}
    this.svcStream = fs.createWriteStream(this.cfg.serviceLogPath, { flags: 'a', mode: 0o600 });

    const args = ['web', '--port', String(this.cfg.port), '--no-open'].concat(this.cfg.forwardArgs || []);
    this.emit('log', '拉起 dsh web：' + bin + ' ' + args.join(' ') + '（cwd=' + this.cfg.workdir + '）');

    const child = spawn(bin, args, {
      cwd: this.cfg.workdir,
      env: childEnvironment(bin),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = child;

    child.stdout.on('data', (d) => this.onOutput(d));
    child.stderr.on('data', (d) => this.onOutput(d));
    child.on('error', (e) => {
      this.setState(STATE.FAILED, '无法启动 dsh web：' + e.message);
    });
    child.on('exit', (code, signal) => {
      this.emit('log', '服务进程已退出（pid=' + child.pid + '，code=' + code + (signal ? '，signal=' + signal : '') + '）');
      this.exitedEarly = true;
      if (this.process === child) {
        this.cleanupOutputs();
        this.process = null;
        try { fs.unlinkSync(this.cfg.serviceStatePath); } catch (e) {}
        if (this.state === STATE.READY || this.isBusy) {
          this.setState(STATE.EXITED, child.pid);
        }
      }
    });

    this.recordServiceProcess(child.pid);

    this.setState(STATE.WAITING_PORT);
    const ready = await this.waitForPort();
    if (!ready) {
      if (this.exitedEarly) {
        const tail = this.recentOutput.slice(-3).join(' / ');
        this.setState(STATE.FAILED, 'dsh web 提前退出');
        throw new Error('dsh web 进程提前退出' + (tail ? '，最后输出：' + tail : ''));
      }
      this.setState(STATE.FAILED, '端口未就绪');
      throw new Error('等待端口 ' + this.cfg.port + ' 就绪超时');
    }
    this.emit('log', '服务就绪：http://127.0.0.1:' + this.cfg.port + '/');

    if (!this.authURL) {
      try { await this.waitForAuthURL(); } catch (e) {
        this.emit('log', '未取到认证地址，退回根地址（cookie 有效仍可进入）');
      }
    }
    this.setState(STATE.READY);
  }

  async waitForPort() {
    const deadline = Date.now() + this.cfg.serviceReadyTimeout * 1000;
    while (Date.now() < deadline) {
      if (await portListening(this.cfg.port)) return true;
      if (this.exitedEarly) return false;
      await sleep(200);
    }
    return false;
  }

  async waitForAuthURL() {
    const deadline = Date.now() + this.cfg.tokenTimeout * 1000;
    while (Date.now() < deadline) {
      if (this.authURL) {
        AuthCache.write(this.cfg.authCachePath, this.authURL);
        return;
      }
      if (this.exitedEarly) throw new Error('服务提前退出');
      await sleep(100);
    }
    throw new Error('未取到认证地址');
  }

  onOutput(buf) {
    const text = buf.toString();
    if (this.rawStream) this.rawStream.write(text);
    if (this.svcStream) this.svcStream.write(redact(text));

    for (const line of text.split('\n')) {
      if (!line) continue;
      this.recentOutput.push(line);
      if (this.recentOutput.length > 20) this.recentOutput.shift();
    }
    if (!this.authURL) {
      const found = this.scanner.feed(text);
      if (found) {
        this.authURL = found;
        AuthCache.write(this.cfg.authCachePath, found);
        this.emit('log', '已解析到认证地址（已缓存，权限 0600）');
        this.emit('auth', found);
      }
    }
  }

  // ---- 重启 / 停止 ----

  async restart() {
    this.restarting = true;
    try {
      this.emit('log', '重启：停止 → 拉起');
      await this.stop(true);
      const deadline = Date.now() + this.cfg.stopTimeout * 1000;
      while (Date.now() < deadline && await this.isListening()) await sleep(200);
      if (await this.isListening()) {
        this.emit('log', '警告：端口 ' + this.cfg.port + ' 在 ' + this.cfg.stopTimeout + ' 秒后仍被占用');
      }
      this.authURL = null;
      AuthCache.clear(this.cfg.authCachePath);
      await this.launch();
    } finally {
      this.restarting = false;
    }
  }

  async stop(force) {
    const child = this.process;
    if (!child) {
      if (!force) {
        this.emit('log', '服务不是本宿主启动的，跳过停止（避免误杀）');
        this.setState(STATE.IDLE);
        return;
      }
      await this.forceStopByPort();
      return;
    }

    const pid = child.pid;
    this.emit('log', '停止服务（pid=' + pid + '）');
    try { child.kill('SIGTERM'); } catch (e) {}

    let deadline = Date.now() + 3000;
    while (Date.now() < deadline && alive(pid)) await sleep(150);
    if (alive(pid)) {
      this.emit('log', 'SIGTERM 后 3 秒仍未退出，发送 SIGKILL');
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
      deadline = Date.now() + 2000;
      while (Date.now() < deadline && alive(pid)) await sleep(100);
    }
    if (alive(pid)) this.emit('log', '警告：服务进程仍未退出（pid=' + pid + '）');

    this.cleanupOutputs();
    this.process = null;
    AuthCache.clear(this.cfg.authCachePath);
    try { fs.unlinkSync(this.cfg.serviceStatePath); } catch (e) {}
    this.authURL = null;
    this.setState(STATE.IDLE);
    this.emit('log', '服务已停止');
  }

  async forceStopByPort() {
    let pids = listeningPIDs(this.cfg.port);
    if (!pids.length) {
      this.emit('log', '端口 ' + this.cfg.port + ' 上没有监听进程，无需停止');
      this.setState(STATE.IDLE);
      return;
    }
    this.emit('log', '强制停止端口 ' + this.cfg.port + ' 上的服务（pid=' + pids.join(',') + '；非本宿主启动）');
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }

    let deadline = Date.now() + 3000;
    while (Date.now() < deadline && listeningPIDs(this.cfg.port).length) await sleep(100);
    pids = listeningPIDs(this.cfg.port);
    if (pids.length) {
      this.emit('log', 'SIGTERM 后 3 秒仍占用端口，发送 SIGKILL（pid=' + pids.join(',') + '）');
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }
      deadline = Date.now() + 2000;
      while (Date.now() < deadline && listeningPIDs(this.cfg.port).length) await sleep(100);
    }
    const left = listeningPIDs(this.cfg.port);
    if (!left.length) this.emit('log', '服务已停止（端口 ' + this.cfg.port + ' 已释放）');
    else this.emit('log', '警告：端口 ' + this.cfg.port + ' 仍被占用（pid=' + left.join(',') + '）');

    this.cleanupOutputs();
    this.process = null;
    AuthCache.clear(this.cfg.authCachePath);
    try { fs.unlinkSync(this.cfg.serviceStatePath); } catch (e) {}
    this.authURL = null;
    this.setState(STATE.IDLE);
  }

  // ---- 服务归属（识别自己留下的残留进程）----

  recordServiceProcess(pid) {
    try {
      fs.mkdirSync(path.dirname(this.cfg.serviceStatePath), { recursive: true });
      fs.writeFileSync(this.cfg.serviceStatePath, JSON.stringify({
        pid: pid,
        port: this.cfg.port,
        startedAt: Date.now()
      }));
    } catch (e) { /* 忽略 */ }
  }

  loadServiceRecord() {
    try {
      const record = JSON.parse(fs.readFileSync(this.cfg.serviceStatePath, 'utf8'));
      if (!record || typeof record.pid !== 'number') return null;
      return record;
    } catch (e) { return null; }
  }

  isOurOrphanedService() {
    const record = this.loadServiceRecord();
    if (!record || record.port !== this.cfg.port) return false;
    if (!alive(record.pid)) {
      this.emit('log', '历史服务进程 pid=' + record.pid + ' 已不存在');
      return false;
    }
    const listeners = listeningPIDs(this.cfg.port);
    const mine = listeners.indexOf(record.pid) >= 0;
    this.emit('log', '端口 ' + this.cfg.port + ' 的监听者=' + listeners.join(',') +
      '；历史记录 pid=' + record.pid + '；判定=' + (mine ? '本宿主此前拉起' : '不是本宿主的'));
    return mine;
  }

  async takeOverOrphanedService() {
    const record = this.loadServiceRecord();
    if (!record || record.port !== this.cfg.port) return;
    this.emit('log', '接管遗留服务（pid=' + record.pid + '）：结束它并重新拉起一个有认证地址的');
    try { process.kill(record.pid, 'SIGTERM'); } catch (e) {}
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline && alive(record.pid)) await sleep(150);
    if (alive(record.pid)) {
      this.emit('log', '遗留服务未响应 SIGTERM，发送 SIGKILL');
      try { process.kill(record.pid, 'SIGKILL'); } catch (e) {}
    }
    deadline = Date.now() + 5000;
    while (Date.now() < deadline && await this.isListening()) await sleep(200);
    this.authURL = null;
    AuthCache.clear(this.cfg.authCachePath);
    await this.launch();
  }

  cleanupOutputs() {
    try { if (this.rawStream) this.rawStream.end(); } catch (e) {}
    try { if (this.svcStream) this.svcStream.end(); } catch (e) {}
    this.rawStream = null;
    this.svcStream = null;
  }
}

// ---------------- 子进程环境 ----------------

function versionDirs(root) {
  try {
    return fs.readdirSync(root).filter((n) => /^v\d+\.\d+\.\d+$/.test(n));
  } catch (e) { return []; }
}

function cmpVer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function nvmRoot() { return path.join(os.homedir(), '.nvm', 'versions', 'node'); }

function nvmVersionsDescending() {
  return versionDirs(nvmRoot()).sort((a, b) => cmpVer(b, a));
}

function nvmDefaultAliasVersion(versions) {
  let alias = '';
  try {
    alias = fs.readFileSync(path.join(os.homedir(), '.nvm', 'alias', 'default'), 'utf8').trim();
  } catch (e) { return versions.length ? versions[0] : null; }
  if (!alias) return versions.length ? versions[0] : null;
  if (/^v\d+\.\d+\.\d+$/.test(alias) && versions.indexOf(alias) >= 0) return alias;
  const prefix = alias.replace(/^v/, '').replace(/[^0-9.].*$/, '');
  if (prefix) {
    const matched = versions.filter((v) => v.replace(/^v/, '').startsWith(prefix));
    if (matched.length) return matched[0];
  }
  return versions.length ? versions[0] : null;
}

// 与 Swift 壳同源：default 别名优先，其余按语义版本降序
function nvmBinDirectoriesForPATH() {
  const versions = nvmVersionsDescending();
  const preferred = nvmDefaultAliasVersion(versions);
  const ordered = [];
  if (preferred) ordered.push(preferred);
  for (const v of versions) if (v !== preferred) ordered.push(v);
  return ordered.map((v) => path.join(nvmRoot(), v, 'bin'));
}

function defaultDshBin() {
  const versions = nvmVersionsDescending();
  const preferred = nvmDefaultAliasVersion(versions);
  const tryBin = (v) => {
    const bin = path.join(nvmRoot(), v, 'bin', 'dsh');
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (e) { return null; }
  };
  if (preferred) {
    const hit = tryBin(preferred);
    if (hit) return hit;
  }
  for (const v of versions) {
    const hit = tryBin(v);
    if (hit) return hit;
  }
  for (const p of ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* 继续 */ }
  }
  return 'dsh';
}

// Finder 启动的进程 PATH 极简，必须补上 nvm 的 node/dsh；顺序决定用哪个 node
function childEnvironment(binaryPath) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (k.indexOf('ELECTRON_') === 0 || k === 'CHROME_DESKTOP') delete env[k];
  }
  const binaryDir = path.dirname(binaryPath);
  const candidates = [binaryDir]
    .concat(nvmBinDirectoriesForPATH())
    .concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);

  const seen = new Set();
  const paths = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    paths.push(dir);
  }
  if (env.PATH) paths.push(env.PATH);
  env.PATH = paths.join(':');
  env.HOME = os.homedir();
  return env;
}

module.exports = {
  STATE,
  ServiceController,
  AuthCache,
  redact,
  firstAuthURL,
  lastAuthURL,
  AuthScanner,
  portListening,
  listeningPIDs,
  defaultDshBin,
  nvmBinDirectoriesForPATH,
  childEnvironment
};
