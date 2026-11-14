import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { inspect, sample } from './domain.js';

const [command = 'demo', file, directory = '.local/archive'] = process.argv.slice(2);
async function run() {
  if (command === 'inspect') {
    if (!file) throw new Error('需要资料路径');
    console.log(JSON.stringify(await inspect(resolve(file)), null, 2));
  } else if (command === 'capture') {
    if (!file) throw new Error('需要资料路径');
    const inventory = await inspect(resolve(file));
    const receipt = await new Archive(directory).accept(await readFile(file),
      { source: resolve(file), inventory });
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await new Archive(file || directory).receipts(), null, 2));
  } else if (command === 'assist') {
    const args = process.argv.slice(3);
    const option = name => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const portalUrl = option('--portal');
    const manifestPath = option('--manifest') || '.local/manifest.json';
    const purpose = option('--purpose') || '资质核验';
    const timeoutMs = Number(option('--timeout') || 60000);
    const files = args.filter((value, index) =>
      !value.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--')));
    if (!portalUrl || !files.length) throw new Error('需要 --portal 与至少一个资料路径');
    const { UploadAssistant } = await import('./assistant.js');
    const assistant = new UploadAssistant({ portalUrl, manifestPath });
    await assistant.open();
    try {
      console.log(JSON.stringify(await assistant.deliver(
        files.map(path => ({ path: resolve(path), purpose })), { timeoutMs }), null, 2));
    } finally { await assistant.close(); }
  } else if (command === 'demo') {
    const temporary = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      const inventory = await inspect(resolve(sample));
      const archive = new Archive(temporary);
      const receipt = await archive.accept(await readFile(sample), { source: sample, inventory });
      console.log(JSON.stringify({ inventory, receipt, verified: (await archive.read(receipt.sha256)).length }, null, 2));
      const domain = await import('./domain.js');
      console.log(JSON.stringify(await domain.livePreview(), null, 2));
      const { startPortal } = await import('./portal.js');
      const { UploadAssistant } = await import('./assistant.js');
      const portal = await startPortal();
      try {
        await fetch(`${portal.url}/api/control`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scanDelayMs: 1200, revokeNext: true }) });
        const assistant = new UploadAssistant({ portalUrl: portal.url,
          manifestPath: join(temporary, 'manifest.json') });
        await assistant.open();
        const manifest = await assistant.deliver(
          [{ path: resolve('fixtures/certificate.txt'), purpose: '资质核验' }], { timeoutMs: 30000 });
        await assistant.close();
        console.log(JSON.stringify({ assistant: {
          materials: portal.state.materials.length,
          revoked: portal.state.uploads.filter(upload => upload.by === 'server').length,
          entries: manifest.entries,
        } }, null, 2));
      } finally { await portal.close(); }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } else { throw new Error('支持 inspect、capture、list、assist、demo'); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
