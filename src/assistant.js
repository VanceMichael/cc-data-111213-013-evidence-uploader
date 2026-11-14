import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

// 终态：不再由助手自动推进；其余状态会在下一轮 reconcile 中继续处理。
const TERMINAL = new Set(['accepted', 'rejected', 'cancelled', 'replaced', 'needs-manual']);
const ACTIVE = new Set(['pending', 'uploading', 'resumable', 'quarantine', 'restart']);

// 材料只按内容摘要与业务用途辨认；临时 upload ID 不进入清单，长期标识是业务记录 materialId。
export function materialKey(digest, purpose) {
  return `${digest}:${purpose}`;
}

// 依据门户页面呈现的上传会话与业务记录，判定一条材料当前该如何处理。
export function classifyUpload(entry, view) {
  const material = view.materials.find(value =>
    value.digest === entry.digest && value.purpose === entry.purpose);
  if (material) return { status: 'accepted', materialId: material.materialId };
  const sessions = view.uploads.filter(value =>
    value.digest === entry.digest && value.purpose === entry.purpose);
  const first = status => sessions.find(value => value.status === status);
  if (first('quarantine')) return { status: 'quarantine' };
  if (first('uploading')) return { status: 'resumable' };
  const rejected = first('rejected');
  if (rejected) return { status: 'rejected', reason: rejected.reason };
  const cancelled = first('cancelled');
  if (cancelled) {
    return cancelled.by === 'server'
      ? { status: 'restart', reason: cancelled.reason }
      : { status: 'cancelled', reason: cancelled.reason };
  }
  if (first('expired')) return { status: 'restart', reason: '上传会话过期' };
  return { status: 'pending' };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class UploadAssistant {
  constructor({ portalUrl, manifestPath, headless = true, pollMs = 200, maxRestarts = 3 }) {
    this.portalUrl = portalUrl;
    this.manifestPath = manifestPath;
    this.headless = headless;
    this.pollMs = pollMs;
    this.maxRestarts = maxRestarts;
    this.manifest = { version: 1, entries: [] };
  }

  async open() {
    try {
      this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
      for (const entry of this.manifest.entries) {
        entry.history ||= [];
        entry.restarts ??= 0;
      }
    } catch { /* 首次运行没有清单 */ }
    this.browser = await chromium.launch({ headless: this.headless, args: ['--no-sandbox'] });
    this.page = await this.browser.newPage();
    await this.page.goto(this.portalUrl);
    await this.page.waitForFunction(() => document.querySelector('#notice').textContent.length > 0);
  }

  async close() {
    await this.save();
    if (this.browser) await this.browser.close();
  }

  async save() {
    if (this.manifestPath) await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  findEntry(key) {
    return this.manifest.entries.find(entry => entry.key === key);
  }

  async record(entry, event, patch = {}) {
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    entry.history.push({ at: entry.updatedAt, event });
    await this.save();
  }

  async hashFile(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  }

  // 以下全部通过页面真实交互完成：文件选择框、上传/续传/刷新/读取按钮，
  // 不直接调用门户内部上传接口代替操作。
  async refreshSeq() {
    return this.page.evaluate(() => document.body.dataset.refreshSeq || '');
  }

  async clickAndSettle(locator, timeout = 30000) {
    const before = await this.refreshSeq();
    await locator.click();
    await this.page.waitForFunction(
      seq => (document.body.dataset.refreshSeq || '') !== seq, before, { timeout });
  }

  async refresh() {
    await this.clickAndSettle(this.page.locator('#refresh'));
  }

  async portalView() {
    await this.refresh();
    const uploads = await this.page.locator('#uploads article')
      .evaluateAll(items => items.map(item => ({ ...item.dataset })));
    const materials = await this.page.locator('#materials article')
      .evaluateAll(items => items.map(item => ({ ...item.dataset })));
    return { uploads, materials };
  }

  async chooseFiles(paths) {
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      this.page.locator('#files').click(),
    ]);
    await chooser.setFiles(paths);
  }

  async waitSelected(digests) {
    await this.page.waitForFunction(expected => {
      const items = Array.from(document.querySelectorAll('#selected article'));
      return items.length === expected.length
        && expected.every(digest => items.some(item => item.dataset.digest === digest));
    }, digests, { timeout: 15000 });
  }

  // 登记材料：同一路径在等待期间被替换时，旧内容与新内容按不同材料区分处理。
  async register(items) {
    for (const item of items) {
      const path = resolve(item.path);
      const content = await readFile(path);
      const digest = createHash('sha256').update(content).digest('hex');
      for (const entry of this.manifest.entries.filter(value =>
        value.path === path && value.purpose === item.purpose
        && value.digest !== digest && !TERMINAL.has(value.status))) {
        await this.record(entry, '等待期间本地文件被替换，旧内容与新内容区分处理', {
          status: 'replaced',
          manual: '本地文件在等待期间被替换；旧内容未送达门户，如需旧内容请人工恢复后重新提交' });
      }
      const key = materialKey(digest, item.purpose);
      if (!this.findEntry(key)) {
        const entry = { key, name: basename(path), path, purpose: item.purpose, digest,
          size: content.length, status: 'pending', materialId: '', reason: '', manual: '',
          verified: false, restarts: 0, history: [], updatedAt: new Date().toISOString() };
        this.manifest.entries.push(entry);
        await this.record(entry, '登记材料（按内容摘要与业务用途辨认）');
      }
    }
  }

  // 读回业务记录并核对摘要，接纳只有核验通过才算完成。
  async verifyMaterial(entry) {
    const article = this.page.locator(`#materials article[data-material-id="${entry.materialId}"]`);
    if (!(await article.count())) {
      await this.record(entry, '门户已接纳但业务记录缺失', {
        status: 'needs-manual', manual: '门户已接纳但业务记录读不到，请人工核查门户' });
      return false;
    }
    await article.getByRole('button', { name: '读取' }).click();
    await this.page.waitForFunction(id => {
      const item = document.querySelector(`#materials article[data-material-id="${id}"]`);
      return item && item.dataset.readback !== '';
    }, entry.materialId, { timeout: 10000 });
    const readback = await article.evaluate(item => item.dataset.readback);
    if (readback === entry.digest) {
      await this.record(entry, '业务记录读回核验一致', { verified: true });
      return true;
    }
    await this.record(entry, `业务记录读回不一致：${readback}`, {
      status: 'needs-manual', verified: false,
      manual: '业务记录读回摘要与本地内容不一致，请人工核查门户存储' });
    return false;
  }

  // 对照门户页面状态推进清单；浏览器重开后调用即可辨认已接纳、仍隔离与可续传的对象。
  async reconcile() {
    const view = await this.portalView();
    const classification = {};
    for (const entry of this.manifest.entries) {
      if (entry.status === 'accepted' && !entry.verified) {
        await this.verifyMaterial(entry);
        classification[entry.key] = entry.status;
        continue;
      }
      if (TERMINAL.has(entry.status)) {
        classification[entry.key] = entry.status;
        continue;
      }
      const result = classifyUpload(entry, view);
      if (result.status === 'accepted') {
        await this.record(entry, '门户已接纳，业务记录可见', {
          status: 'accepted', materialId: result.materialId });
        await this.verifyMaterial(entry);
      } else if (result.status === 'rejected') {
        await this.record(entry, `服务端扫描拒绝：${result.reason}`, {
          status: 'rejected', reason: result.reason || '',
          manual: `扫描拒绝（${result.reason}），需人工确认内容后重新制作资料；不要靠改文件后缀重提` });
      } else if (result.status === 'cancelled') {
        await this.record(entry, `人工取消：${result.reason}`, {
          status: 'cancelled', reason: result.reason || '',
          manual: '人工已取消，如需提交请人工重新办理' });
      } else if (result.status === 'restart') {
        if (entry.restarts >= this.maxRestarts) {
          await this.record(entry, `会话反复失败（${entry.restarts} 次）：${result.reason}`, {
            status: 'needs-manual',
            manual: `上传会话多次被撤销或过期（${result.reason}），请人工核查门户后重试` });
        } else {
          await this.record(entry, `上传会话可重建：${result.reason}`, { status: 'restart' });
        }
      } else if (result.status !== entry.status) {
        const event = { quarantine: '资料在隔离区等待扫描', resumable: '会话仍有进度，可续传',
          pending: '门户侧暂无记录，等待提交' }[result.status] || `门户状态：${result.status}`;
        await this.record(entry, event, { status: result.status });
      }
      classification[entry.key] = entry.status;
    }
    await this.save();
    return classification;
  }

  // 动作前复核本地内容：等待期间被替换的文件不能混用字节。
  async ensureLocalUnchanged(entry) {
    let digest;
    try {
      digest = await this.hashFile(entry.path);
    } catch {
      await this.record(entry, '本地文件不可读', {
        status: 'needs-manual', manual: '本地文件不可读，请人工确认资料路径' });
      return false;
    }
    if (digest === entry.digest) return true;
    await this.record(entry, '等待期间本地文件被替换，旧内容与新内容区分处理', {
      status: 'replaced',
      manual: '本地文件在等待期间被替换；旧内容未送达门户，如需旧内容请人工恢复后重新提交' });
    await this.register([{ path: entry.path, purpose: entry.purpose }]);
    return false;
  }

  async uploadGroup(purpose, entries) {
    await this.page.locator('#purpose').fill(purpose);
    await this.chooseFiles(entries.map(entry => entry.path));
    await this.waitSelected(entries.map(entry => entry.digest));
    await this.clickAndSettle(this.page.locator('#upload'));
    for (const entry of entries) {
      const restarted = entry.status === 'restart';
      await this.record(entry,
        restarted ? '会话被撤销或过期后重新建立上传会话' : '已通过页面文件选择建立上传会话',
        { status: 'uploading' });
    }
  }

  async act() {
    for (const entry of this.manifest.entries.filter(value => value.status === 'resumable')) {
      if (!(await this.ensureLocalUnchanged(entry))) continue;
      const article = this.page.locator(
        `#uploads article[data-digest="${entry.digest}"][data-status="uploading"]`);
      if (!(await article.count())) continue;
      await this.chooseFiles([entry.path]);
      await this.waitSelected([entry.digest]);
      await this.clickAndSettle(article.getByRole('button', { name: '续传' }));
      await this.record(entry, '从断点续传', { status: 'uploading' });
    }
    const groups = new Map();
    for (const entry of this.manifest.entries.filter(value =>
      value.status === 'pending' || value.status === 'restart')) {
      if (!(await this.ensureLocalUnchanged(entry))) continue;
      if (entry.status === 'restart') entry.restarts += 1;
      if (!groups.has(entry.purpose)) groups.set(entry.purpose, []);
      groups.get(entry.purpose).push(entry);
    }
    for (const [purpose, entries] of groups) await this.uploadGroup(purpose, entries);
  }

  // 交付完成标准：门户已接纳且业务记录可按摘要读回，而不是浏览器把字节发完。
  async deliver(items, { timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    await this.register(items);
    while (Date.now() < deadline) {
      await this.reconcile();
      if (!this.manifest.entries.some(entry => ACTIVE.has(entry.status))) break;
      await this.act();
      await sleep(this.pollMs);
    }
    for (const entry of this.manifest.entries.filter(value => ACTIVE.has(value.status))) {
      await this.record(entry, '处理超时', {
        status: 'needs-manual', manual: '等待门户处理超时，请人工核查门户状态后重试' });
    }
    await this.save();
    return this.manifest;
  }
}
