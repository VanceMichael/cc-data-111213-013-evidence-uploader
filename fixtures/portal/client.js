const query = selector => document.querySelector(selector);
async function api(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.status || '操作未接纳');
  return data;
}
function notice(value) { query('#notice').textContent = typeof value === 'string' ? value : JSON.stringify(value); }
window.addEventListener('unhandledrejection', event => { event.preventDefault(); notice(event.reason.message); });

const CHUNK = 1024;
const hex = buffer => Array.from(new Uint8Array(buffer)).map(value => value.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const digestOf = bytes => crypto.subtle.digest('SHA-256', bytes).then(hex);
const digestOfFile = async file => digestOf(new Uint8Array(await file.arrayBuffer()));
const bump = () => { document.body.dataset.refreshSeq = String(Number(document.body.dataset.refreshSeq || 0) + 1); };

// 续传与上传都以服务端当前持有的分片为准：过期或被清理的分片会重新补齐。
async function transfer(file, sessionId) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await digestOf(bytes);
  const total = Math.ceil(bytes.length / CHUNK);
  for (let round = 0; round < 8; round++) {
    const state = await api('/api/state');
    const upload = state.uploads.find(value => value.id === sessionId);
    if (!upload) throw new Error('上传会话不存在');
    if (upload.status === 'expired') throw new Error('上传会话过期');
    if (upload.status !== 'uploading') throw new Error(`会话状态不可写：${upload.status}`);
    if (upload.digest !== digest) throw new Error('选择的内容与上传会话不一致');
    for (let index = 0; index < total; index++) {
      if (upload.chunks.includes(index)) continue;
      const part = bytes.slice(index * CHUNK, (index + 1) * CHUNK);
      await api(`/api/upload/${sessionId}/chunk`, { index, bytes: b64(part) });
    }
    try { await api(`/api/upload/${sessionId}/finish`, {}); return; }
    catch (error) { if (!/摘要不一致/.test(error.message)) throw error; }
  }
  throw new Error('分片反复缺失，无法完成上传');
}

function renderUploads(uploads) {
  const section = query('#uploads');
  section.replaceChildren();
  for (const upload of uploads) {
    const item = document.createElement('article');
    Object.assign(item.dataset, { id: upload.id, name: upload.name, purpose: upload.purpose,
      digest: upload.digest, type: upload.type || '', status: upload.status,
      materialId: upload.materialId || '', reason: upload.reason || '', by: upload.by || '',
      chunks: String(upload.chunks.length) });
    const summary = document.createElement('span');
    summary.textContent = `${upload.name} ${upload.purpose} ${upload.digest} ${upload.type || ''} ${upload.status} ${upload.materialId || ''} ${upload.reason || ''} 分片${upload.chunks.length}`;
    item.append(summary);
    if (upload.status === 'uploading' || upload.status === 'quarantine') {
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.onclick = async () => {
        try { await api(`/api/upload/${upload.id}/cancel`, { by: 'user' }); }
        catch (error) { notice(error.message); }
        finally { await refresh(); }
      };
      item.append(cancel);
    }
    if (upload.status === 'uploading') {
      const resume = document.createElement('button');
      resume.textContent = '续传';
      resume.onclick = async () => {
        try {
          for (const file of Array.from(query('#files').files))
            if (await digestOfFile(file) === upload.digest) { await transfer(file, upload.id); return; }
          throw new Error('请重新选择对应内容的本地资料');
        } catch (error) { notice(error.message); }
        finally { await refresh(); }
      };
      item.append(resume);
    }
    section.append(item);
  }
}

function renderMaterials(materials) {
  const section = query('#materials');
  section.replaceChildren();
  for (const material of materials) {
    const item = document.createElement('article');
    Object.assign(item.dataset, { materialId: material.materialId, name: material.name,
      purpose: material.purpose, digest: material.digest, type: material.type || '', readback: '' });
    const summary = document.createElement('span');
    summary.textContent = `业务记录 ${material.name} ${material.purpose} ${material.type} ${material.digest} ${material.materialId}`;
    const read = document.createElement('button');
    read.textContent = '读取';
    const output = document.createElement('output');
    read.onclick = async () => {
      try {
        const record = await api(`/api/materials/${material.materialId}`);
        const bytes = Uint8Array.from(atob(record.content), char => char.charCodeAt(0));
        const digest = await digestOf(bytes);
        item.dataset.readback = digest === material.digest ? digest : '不一致';
        output.textContent = `已读回 ${digest} ${bytes.length}字节`;
      } catch (error) { item.dataset.readback = '读取失败'; output.textContent = error.message; }
    };
    item.append(summary, read, output);
    section.append(item);
  }
}

async function refresh() {
  const data = await api('/api/state');
  renderUploads(data.uploads);
  renderMaterials(data.materials);
  const events = query('#audit');
  events.replaceChildren();
  for (const line of data.audit.slice(-30)) {
    const item = document.createElement('li');
    item.textContent = `${line.at} ${line.event} ${line.detail || ''}`;
    events.append(item);
  }
  bump();
}

// 选择资料后先请服务端识别类型与摘要，再决定是否上传。
query('#files').onchange = async () => {
  const selected = query('#selected');
  selected.replaceChildren();
  for (const file of Array.from(query('#files').files)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await api('/api/identify', { name: file.name, bytes: b64(bytes) });
    const item = document.createElement('article');
    Object.assign(item.dataset, { name: file.name, digest: info.digest, type: info.type });
    item.textContent = `待传 ${file.name} ${info.type} ${info.digest}`;
    selected.append(item);
  }
};

query('#upload').onclick = async () => {
  try {
    const files = Array.from(query('#files').files);
    if (!files.length) { notice('请先选择资料'); return; }
    const purpose = query('#purpose').value;
    await Promise.all(files.map(async file => {
      const digest = await digestOfFile(file);
      const upload = await api('/api/upload/new', { name: file.name, digest, purpose, size: file.size });
      await transfer(file, upload.id);
    }));
    notice('字节已送达，等待扫描');
  } catch (error) { notice(error.message); }
  finally { await refresh(); }
};
query('#refresh').onclick = refresh;
await refresh();
notice('资料清单已读取');
