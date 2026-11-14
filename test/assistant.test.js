import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPortal } from '../src/portal.js';
import { UploadAssistant, materialKey } from '../src/assistant.js';

const sha256 = content => createHash('sha256').update(content).digest('hex');

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待条件超时');
}

async function control(portal, patch) {
  const response = await fetch(`${portal.url}/api/control`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  assert.equal(response.status, 200);
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'assistant-'));
}

test('延迟扫描与服务端撤销后恢复，业务附件不重复', { timeout: 60000 }, async () => {
  const portal = await startPortal();
  const dir = await workspace();
  try {
    await control(portal, { scanDelayMs: 800, revokeNext: true });
    const file = join(dir, 'certificate.txt');
    await writeFile(file, '合成检测证明：SYN-001\n');
    const digest = sha256(Buffer.from('合成检测证明：SYN-001\n'));
    const assistant = new UploadAssistant({ portalUrl: portal.url, manifestPath: join(dir, 'manifest.json') });
    await assistant.open();
    const manifest = await assistant.deliver([{ path: file, purpose: '资质核验' }], { timeoutMs: 30000 });
    await assistant.close();

    const sessions = portal.state.uploads.filter(upload => upload.digest === digest);
    assert.equal(sessions.filter(upload => upload.status === 'cancelled' && upload.by === 'server').length, 1);
    assert.equal(sessions.filter(upload => upload.status === 'accepted').length, 1);
    const materials = portal.state.materials.filter(material => material.digest === digest);
    assert.equal(materials.length, 1, '恢复后只能有一条业务附件');

    const entry = manifest.entries.find(value => value.digest === digest);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.verified, true, '业务记录必须读回核验');
    assert.equal(entry.materialId, materials[0].materialId, '长期标识取自业务记录');
    assert.ok(entry.history.some(line => /撤销|重建/.test(line.event)));
    const serialized = JSON.stringify(manifest);
    for (const session of sessions)
      assert.ok(!serialized.includes(session.id), '清单不得把临时 upload ID 当成资料标识');
    assert.ok(portal.audit.some(line => line.event === '服务端撤销会话'));
  } finally {
    await portal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('扫描拒绝留痕且不能靠改后缀绕过', { timeout: 60000 }, async () => {
  const portal = await startPortal();
  const dir = await workspace();
  try {
    await control(portal, { scanDelayMs: 300 });
    const content = '季度材料 REJECT-ME 演练内容';
    const file = join(dir, 'evidence.bin');
    await writeFile(file, content);
    const digest = sha256(Buffer.from(content));
    const assistant = new UploadAssistant({ portalUrl: portal.url, manifestPath: join(dir, 'manifest.json') });
    await assistant.open();
    const manifest = await assistant.deliver([{ path: file, purpose: '季度合规材料' }], { timeoutMs: 20000 });

    const entry = manifest.entries.find(value => value.digest === digest);
    assert.equal(entry.status, 'rejected');
    assert.match(entry.reason, /演练策略拒绝/);
    assert.ok(entry.manual.length > 0, '清单要留下可人工处理的事项');
    assert.equal(entry.materialId, '');
    assert.equal(portal.state.uploads.filter(upload => upload.digest === digest).length, 1,
      '被拒绝后助手不自动重提');
    assert.equal(portal.state.materials.length, 0);

    // 人工把同样内容改名后重提，门户按内容识别，仍然拒绝。
    const renamed = join(dir, 'notes.txt');
    await writeFile(renamed, content);
    await assistant.page.locator('#purpose').fill('季度合规材料');
    const [chooser] = await Promise.all([
      assistant.page.waitForEvent('filechooser'),
      assistant.page.locator('#files').click(),
    ]);
    await chooser.setFiles(renamed);
    await assistant.clickAndSettle(assistant.page.locator('#upload'));
    await waitFor(() => portal.state.uploads.filter(upload =>
      upload.digest === digest && upload.status === 'rejected').length === 2);
    assert.equal(portal.state.materials.length, 0, '改后缀不能绕过扫描拒绝');
    await assistant.close();
  } finally {
    await portal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('浏览器重开后辨认已接纳、仍隔离与可续传对象', { timeout: 90000 }, async () => {
  const portal = await startPortal();
  const dir = await workspace();
  try {
    const purpose = '资质核验';
    const fileA = join(dir, 'a.txt');
    const fileB = join(dir, 'b.txt');
    const fileC = join(dir, 'c.txt');
    await writeFile(fileA, '甲公司营业执照\n');
    await writeFile(fileB, '乙公司检测报告\n');
    await writeFile(fileC, '丙'.repeat(1500));
    const digestA = sha256(Buffer.from('甲公司营业执照\n'));
    const digestB = sha256(Buffer.from('乙公司检测报告\n'));
    const digestC = sha256(Buffer.from('丙'.repeat(1500)));
    const manifestPath = join(dir, 'manifest.json');

    await control(portal, { scanDelayMs: 300 });
    const first = new UploadAssistant({ portalUrl: portal.url, manifestPath });
    await first.open();
    await first.deliver([{ path: fileA, purpose }], { timeoutMs: 20000 });
    assert.equal(portal.state.materials.filter(material => material.digest === digestA).length, 1);

    // B 被拖延扫描，C 传到一半时浏览器被关闭。
    await control(portal, { scanDelayMs: 60000, chunkDelayMs: 250 });
    const pending = first.deliver([{ path: fileB, purpose }, { path: fileC, purpose }],
      { timeoutMs: 60000 }).catch(() => {});
    await waitFor(() => {
      const sessionB = portal.state.uploads.find(upload => upload.digest === digestB);
      const sessionC = portal.state.uploads.find(upload => upload.digest === digestC);
      return sessionB?.status === 'quarantine' && sessionC?.status === 'uploading'
        && Object.keys(sessionC.chunks).length >= 1;
    });
    await first.browser.close();
    await pending;

    // 重开前让已送达的分片过期。
    await control(portal, { chunkDelayMs: 0, chunkTtlMs: 1 });
    const second = new UploadAssistant({ portalUrl: portal.url, manifestPath });
    await second.open();
    const classification = await second.reconcile();
    assert.equal(classification[materialKey(digestA, purpose)], 'accepted');
    assert.equal(classification[materialKey(digestB, purpose)], 'quarantine');
    assert.equal(classification[materialKey(digestC, purpose)], 'resumable');

    await control(portal, { scanDelayMs: 300, chunkTtlMs: 0 });
    const manifest = await second.deliver(
      [{ path: fileA, purpose }, { path: fileB, purpose }, { path: fileC, purpose }],
      { timeoutMs: 30000 });
    await second.close();

    for (const digest of [digestA, digestB, digestC]) {
      assert.equal(portal.state.materials.filter(material => material.digest === digest).length, 1,
        '每份材料只能有一条业务附件');
      assert.equal(manifest.entries.find(entry => entry.digest === digest).status, 'accepted');
    }
    assert.equal(portal.state.uploads.filter(upload => upload.digest === digestA).length, 1,
      '已接纳材料不得重传');
    assert.ok(portal.audit.some(line => line.event === '分片过期清理'), '应留下分片过期事件');
    assert.ok(manifest.entries.find(entry => entry.digest === digestC)
      .history.some(line => /续传/.test(line.event)));
  } finally {
    await portal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('等待期间本地文件被替换时按新内容另行辨认', { timeout: 60000 }, async () => {
  const portal = await startPortal();
  const dir = await workspace();
  try {
    await control(portal, { scanDelayMs: 300, chunkDelayMs: 300 });
    const file = join(dir, 'report.txt');
    await writeFile(file, '原始内容-v1');
    const digestV1 = sha256(Buffer.from('原始内容-v1'));
    const digestV2 = sha256(Buffer.from('替换内容-v2'));
    const manifestPath = join(dir, 'manifest.json');

    const first = new UploadAssistant({ portalUrl: portal.url, manifestPath });
    await first.open();
    const pending = first.deliver([{ path: file, purpose: '季度合规材料' }],
      { timeoutMs: 30000 }).catch(() => {});
    await waitFor(() => {
      const session = portal.state.uploads.find(upload => upload.digest === digestV1);
      return session?.status === 'uploading' && Object.keys(session.chunks).length >= 1;
    });
    await first.browser.close();
    await pending;

    await writeFile(file, '替换内容-v2');
    await control(portal, { chunkDelayMs: 0 });
    const second = new UploadAssistant({ portalUrl: portal.url, manifestPath });
    await second.open();
    const manifest = await second.deliver([{ path: file, purpose: '季度合规材料' }],
      { timeoutMs: 30000 });
    await second.close();

    const oldEntry = manifest.entries.find(entry => entry.digest === digestV1);
    const newEntry = manifest.entries.find(entry => entry.digest === digestV2);
    assert.equal(oldEntry.status, 'replaced');
    assert.match(oldEntry.manual, /替换/);
    assert.equal(newEntry.status, 'accepted');
    assert.equal(newEntry.verified, true);
    assert.equal(portal.state.materials.filter(material => material.digest === digestV1).length, 0,
      '旧内容不得进入业务记录');
    assert.equal(portal.state.materials.length, 1, '替换恢复后不得出现重复业务附件');
    assert.equal(portal.state.materials[0].digest, digestV2);
  } finally {
    await portal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('人工取消后助手留痕而不自动重提', { timeout: 60000 }, async () => {
  const portal = await startPortal();
  const dir = await workspace();
  try {
    await control(portal, { scanDelayMs: 60000 });
    const file = join(dir, 'license.txt');
    await writeFile(file, '特许经营许可证\n');
    const digest = sha256(Buffer.from('特许经营许可证\n'));
    const assistant = new UploadAssistant({ portalUrl: portal.url, manifestPath: join(dir, 'manifest.json') });
    await assistant.open();
    const done = assistant.deliver([{ path: file, purpose: '资质核验' }], { timeoutMs: 20000 });
    await waitFor(() => portal.state.uploads.some(upload =>
      upload.digest === digest && upload.status === 'quarantine'));
    await assistant.page.getByRole('button', { name: '取消', exact: true }).click();
    const manifest = await done;
    await assistant.close();

    const entry = manifest.entries.find(value => value.digest === digest);
    assert.equal(entry.status, 'cancelled');
    assert.match(`${entry.reason} ${entry.manual}`, /人工取消/);
    assert.equal(portal.state.uploads.filter(upload => upload.digest === digest).length, 1,
      '人工取消后不得自动重提');
    assert.equal(portal.state.materials.length, 0);
  } finally {
    await portal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
