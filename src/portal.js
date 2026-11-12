import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

export async function startPortal(options = {}) {
  const state = JSON.parse(await readFile('fixtures/state.json', 'utf8'));
  const sessions = new Map();
  const audit = [];
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
        Object.assign(state, body);
        return json(response, { ok: true });
      }
      if (url.pathname === '/api/state') return json(response, { ...state, identity, audit });
      if (url.pathname === '/api/upload/new' && request.method === 'POST') {
        const upload = { id: randomUUID(), name: body.name, digest: body.digest, purpose: body.purpose,
          chunks: {}, status: 'uploading', expires: Date.now() + 60000 };
        state.uploads.push(upload);
        return json(response, upload);
      }
      if (url.pathname.startsWith('/api/upload/') && request.method === 'POST') {
        const [id, action] = url.pathname.slice('/api/upload/'.length).split('/');
        const upload = state.uploads.find(value => value.id === id);
        if (!upload) return json(response, { error: '上传会话不存在' }, 404);
        if (upload.expires < Date.now()) return json(response, { error: '上传会话过期' }, 410);
        if (action === 'cancel') upload.status = 'cancelled';
        if (action === 'chunk') {
          if (upload.status !== 'uploading') return json(response, { error: '会话不可写' }, 409);
          upload.chunks[body.index] = body.bytes;
        }
        if (action === 'finish') {
          if (upload.status !== 'uploading') return json(response, { error: '会话不可完成' }, 409);
          const content = Buffer.concat(Object.keys(upload.chunks).map(Number).sort((left,right) => left-right)
            .map(index => Buffer.from(upload.chunks[index], 'base64')));
          if (createHash('sha256').update(content).digest('hex') !== upload.digest) return json(response, { error: '摘要不一致' }, 409);
          upload.status = 'quarantine';
          upload.type = upload.name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream';
        }
        if (action === 'scan') {
          if (upload.status !== 'quarantine') return json(response, { error: '资料不在隔离区' }, 409);
          upload.status = body.accept ? 'accepted' : 'rejected';
          if (body.accept) upload.materialId = randomUUID();
          else upload.reason = '演练策略拒绝';
        }
        return json(response, upload);
      }
      const allowed = { '/': ['portal.html','text/html; charset=utf-8'], '/client.js': ['client.js','text/javascript'],
        '/service-worker.js': ['service-worker.js','text/javascript'] };
      if (allowed[url.pathname]) {
        const [name,type] = allowed[url.pathname];
        response.setHeader('content-type',type); response.setHeader('cache-control','no-cache');
        return response.end(await readFile(`fixtures/portal/${name}`));
      }
      json(response, { error: '没有这个入口' }, 404);
    } catch (error) { json(response, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state,
    close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1]?.endsWith('/portal.js')) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const portal = await startPortal({ port });
  console.log(`本地门户：${portal.url}`);
}
