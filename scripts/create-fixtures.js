import {writeFile,mkdir} from 'node:fs/promises';
await mkdir('fixtures',{recursive:true});
await writeFile('fixtures/state.json',JSON.stringify({"uploads": [], "materials": [], "controls": {"scanDelayMs": null, "chunkTtlMs": 0, "sessionTtlMs": 60000, "chunkDelayMs": 0, "revokeNext": false, "rejectMarker": "REJECT-ME"}},null,2));
await writeFile('fixtures/portal.json',JSON.stringify({"title": "资料上传控件的可续交付自动化", "local": true, "roles": ["人工使用者"], "entry": "/", "scenario": "evidence-uploader"},null,2));
await writeFile('fixtures/certificate.txt','合成检测证明：SYN-001\n');
