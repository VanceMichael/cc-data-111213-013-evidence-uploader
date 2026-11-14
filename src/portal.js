import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

const CHUNK_INDEX_LIMIT = 100000;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// 类型按内容识别，与文件名后缀无关，避免改后缀绕过扫描策略。
export function recognizeType(content) {
  if (content.length >= 2 && content[0] === 0x4d && content[1] === 0x5a) return 'application/x-executable';
  if (content.length >= 4 && content[0] === 0x7f && content[1] === 0x45 && content[2] === 0x4c && content[3] === 0x46)
    return 'application/x-executable';
  const text = content.toString('utf8');
  if (!text.includes('�') && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return 'text/plain';
  return 'application/octet-stream';
}

const defaultControls = () => ({
  scanDelayMs: null,   // 隔离区扫描延迟；null 表示只接受人工 /scan
  chunkTtlMs: 0,       // 分片在服务端保留时长；0 表示不过期
  sessionTtlMs: 60000, // 上传会话有效期
  chunkDelayMs: 0,     // 每个分片响应前的人为延迟，用于演练中断
  revokeNext: false,   // 撤销下一条收到分片的上传会话（一次性）
  rejectMarker: 'REJECT-ME', // 扫描拒绝标记（合成演练）
});

export async function startPortal(options = {}) {
  const persisted = JSON.parse(await readFile('fixtures/state.json', 'utf8'));
  const state = { uploads: [], materials: [], ...persisted,
    controls: { ...defaultControls(), ...(persisted.controls || {}) } };
  const sessions = new Map();
  const audit = [];
  const scanTimers = new Map();
  const note = (event, detail) => {
    audit.push({ at: new Date().toISOString(), event, detail });
    if (audit.length > 500) audit.shift();
  };
  const view = upload => ({ id: upload.id, name: upload.name, digest: upload.digest,
    purpose: upload.purpose, size: upload.size, status: upload.status, type: upload.type,
    materialId: upload.materialId, reason: upload.reason, by: upload.by,
    chunks: Object.keys(upload.chunks).map(Number).sort((left, right) => left - right) });
  const withoutContent = ({ content, ...material }) => material;

  function maintain(upload) {
    const now = Date.now();
    if (upload.status !== 'uploading') return;
    if (upload.expires < now) {
      upload.status = 'expired';
      note('会话过期', upload.digest.slice(0, 12));
      return;
    }
    const ttl = state.controls.chunkTtlMs;
    if (ttl > 0) {
      const lost = Object.entries(upload.chunks)
        .filter(([, chunk]) => chunk.at + ttl < now).map(([index]) => Number(index));
      for (const index of lost) delete upload.chunks[index];
      if (lost.length) note('分片过期清理', `${upload.digest.slice(0, 12)} 丢失分片 ${lost.join(',')}`);
    }
  }
  function accept(upload) {
    upload.status = 'accepted';
    upload.materialId = randomUUID();
    state.materials.push({ materialId: upload.materialId, name: upload.name, digest: upload.digest,
      purpose: upload.purpose, type: upload.type, size: upload.content.length,
      acceptedAt: new Date().toISOString(), content: upload.content.toString('base64') });
    note('扫描接纳', `${upload.digest.slice(0, 12)} → ${upload.materialId}`);
  }
  function reject(upload, reason) {
    upload.status = 'rejected';
    upload.reason = reason;
    note('扫描拒绝', `${upload.digest.slice(0, 12)} ${reason}`);
  }
  function scan(upload) {
    if (upload.status !== 'quarantine') return;
    if (upload.type === 'application/x-executable') return reject(upload, '演练策略拒绝：可执行内容');
    if (upload.content.toString('utf8').includes(state.controls.rejectMarker))
      return reject(upload, '演练策略拒绝：内容命中标记');
    accept(upload);
  }
  function scheduleScan(upload) {
    const existing = scanTimers.get(upload);
    if (existing) clearTimeout(existing);
    scanTimers.delete(upload);
    const delay = state.controls.scanDelayMs;
    if (delay === null || delay === undefined) return;
    note('扫描排队', `${upload.digest.slice(0, 12)} 延迟 ${delay}ms`);
    const timer = setTimeout(() => { scanTimers.delete(upload); scan(upload); }, delay);
    timer.unref();
    scanTimers.set(upload, timer);
  }

  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const buffers = [];
      for await (const part of request) buffers.push(part);
      const raw = Buffer.concat(buffers);
      const body = raw.length ? JSON.parse(raw) : {};
      const token = /session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
      const identity = sessions.get(token);
      if (request.method === 'POST' && url.pathname === '/api/control') {
        for (const [key, value] of Object.entries(body))
          if (Object.hasOwn(state.controls, key)) state.controls[key] = value;
        note('控制调整', JSON.stringify(body));
        if (Object.hasOwn(body, 'scanDelayMs'))
          for (const upload of state.uploads) if (upload.status === 'quarantine') scheduleScan(upload);
        return json(response, { ok: true, controls: state.controls });
      }
      if (url.pathname === '/api/state') {
        for (const upload of state.uploads) maintain(upload);
        return json(response, { uploads: state.uploads.map(view),
          materials: state.materials.map(withoutContent), controls: state.controls, identity, audit });
      }
      if (url.pathname === '/api/identify' && request.method === 'POST') {
        const content = Buffer.from(String(body.bytes || ''), 'base64');
        return json(response, { name: body.name, size: content.length,
          digest: sha256(content), type: recognizeType(content) });
      }
      if (url.pathname === '/api/materials' && request.method === 'GET')
        return json(response, state.materials.map(withoutContent));
      if (url.pathname.startsWith('/api/materials/') && request.method === 'GET') {
        const material = state.materials.find(value =>
          value.materialId === decodeURIComponent(url.pathname.slice('/api/materials/'.length)));
        if (!material) return json(response, { error: '业务记录不存在' }, 404);
        const content = Buffer.from(material.content, 'base64');
        return json(response, { ...material, digest: sha256(content), size: content.length });
      }
      if (url.pathname === '/api/upload/new' && request.method === 'POST') {
        if (!body.name || !/^[a-f0-9]{64}$/.test(body.digest || ''))
          return json(response, { error: '上传登记信息不完整' }, 400);
        const upload = { id: randomUUID(), name: body.name, digest: body.digest,
          purpose: body.purpose, size: body.size, chunks: {}, status: 'uploading',
          expires: Date.now() + state.controls.sessionTtlMs };
        state.uploads.push(upload);
        note('会话建立', `${upload.digest.slice(0, 12)} ${upload.name}`);
        return json(response, view(upload));
      }
      if (url.pathname.startsWith('/api/upload/') && request.method === 'POST') {
        const [id, action] = url.pathname.slice('/api/upload/'.length).split('/');
        const upload = state.uploads.find(value => value.id === id);
        if (!upload) return json(response, { error: '上传会话不存在' }, 404);
        maintain(upload);
        if (action === 'cancel') {
          if (!['uploading', 'quarantine'].includes(upload.status))
            return json(response, { error: '当前状态不可取消' }, 409);
          upload.status = 'cancelled';
          upload.by = body.by === 'user' ? 'user' : 'server';
          upload.reason = upload.by === 'user' ? '人工取消' : '服务端取消';
          note('取消会话', `${upload.digest.slice(0, 12)} ${upload.reason}`);
          return json(response, view(upload));
        }
        if (upload.status === 'expired') return json(response, { error: '上传会话过期' }, 410);
        if (action === 'chunk') {
          if (upload.status !== 'uploading') return json(response, { error: '会话不可写' }, 409);
          if (!Number.isInteger(body.index) || body.index < 0 || body.index > CHUNK_INDEX_LIMIT)
            return json(response, { error: '分片序号无效' }, 400);
          upload.chunks[body.index] = { bytes: String(body.bytes || ''), at: Date.now() };
          if (state.controls.chunkDelayMs > 0)
            await new Promise(resolve => setTimeout(resolve, state.controls.chunkDelayMs));
          if (state.controls.revokeNext) {
            state.controls.revokeNext = false;
            upload.status = 'cancelled';
            upload.by = 'server';
            upload.reason = '服务端撤销（演练）';
            upload.chunks = {};
            note('服务端撤销会话', upload.digest.slice(0, 12));
          }
          return json(response, view(upload));
        }
        if (action === 'finish') {
          if (upload.status !== 'uploading') return json(response, { error: '会话不可完成' }, 409);
          const content = Buffer.concat(Object.keys(upload.chunks).map(Number)
            .sort((left, right) => left - right)
            .map(index => Buffer.from(upload.chunks[index].bytes, 'base64')));
          if (sha256(content) !== upload.digest) return json(response, { error: '摘要不一致' }, 409);
          upload.content = content;
          upload.type = recognizeType(content);
          upload.status = 'quarantine';
          note('进入隔离区', `${upload.digest.slice(0, 12)} ${upload.type}`);
          scheduleScan(upload);
          return json(response, view(upload));
        }
        if (action === 'scan') {
          if (upload.status !== 'quarantine') return json(response, { error: '资料不在隔离区' }, 409);
          if (body.accept) accept(upload);
          else reject(upload, '演练策略拒绝');
          return json(response, view(upload));
        }
        return json(response, { error: '没有这个操作' }, 404);
      }
      const allowed = { '/': ['portal.html', 'text/html; charset=utf-8'], '/client.js': ['client.js', 'text/javascript'],
        '/service-worker.js': ['service-worker.js', 'text/javascript'] };
      if (allowed[url.pathname]) {
        const [name, type] = allowed[url.pathname];
        response.setHeader('content-type', type); response.setHeader('cache-control', 'no-cache');
        return response.end(await readFile(`fixtures/portal/${name}`));
      }
      json(response, { error: '没有这个入口' }, 404);
    } catch (error) { json(response, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, audit,
    close: () => { for (const timer of scanTimers.values()) clearTimeout(timer); scanTimers.clear();
      return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1]?.endsWith('/portal.js')) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const portal = await startPortal({ port });
  console.log(`本地门户：${portal.url}`);
}
