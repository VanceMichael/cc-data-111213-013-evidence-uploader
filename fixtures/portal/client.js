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

const hex=buffer=>Array.from(new Uint8Array(buffer)).map(value=>value.toString(16).padStart(2,'0')).join('');
async function transfer(file,upload){const bytes=new Uint8Array(await file.arrayBuffer());const digest=hex(await crypto.subtle.digest('SHA-256',bytes));if(digest!==upload.digest)throw new Error('选择的内容与上传会话不一致');for(let offset=0;offset<bytes.length;offset+=1024){if(upload.chunks[offset/1024]!==undefined)continue;const part=bytes.slice(offset,offset+1024);await api(`/api/upload/${upload.id}/chunk`,{index:offset/1024,bytes:btoa(String.fromCharCode(...part))});}await api(`/api/upload/${upload.id}/finish`,{});notice('字节已送达，等待扫描');await refresh();}
async function refresh(){const data=await api('/api/state');query('#uploads').replaceChildren();for(const upload of data.uploads){const item=document.createElement('article');item.dataset.id=upload.id;item.textContent=`${upload.name} ${upload.purpose} ${upload.digest} ${upload.type||''} ${upload.status} ${upload.materialId||''} ${upload.reason||''}`;const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=async()=>{await api(`/api/upload/${upload.id}/cancel`,{});await refresh();};item.append(cancel);if(upload.status==='uploading'){const resume=document.createElement('button');resume.textContent='续传';resume.onclick=async()=>{const files=Array.from(query('#files').files).filter(file=>file.name===upload.name);for(const file of files){const digest=hex(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));if(digest===upload.digest)return transfer(file,upload);}throw new Error('请重新选择对应内容的本地资料');};item.append(resume);}query('#uploads').append(item);}}
query('#upload').onclick=async()=>{for(const file of query('#files').files){const bytes=new Uint8Array(await file.arrayBuffer());const digest=hex(await crypto.subtle.digest('SHA-256',bytes));const upload=await api('/api/upload/new',{name:file.name,digest,purpose:query('#purpose').value});
await transfer(file,upload);}await refresh();};
query('#refresh').onclick=refresh;await refresh();notice('资料清单已读取');
