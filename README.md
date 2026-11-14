# 资料上传控件的可续交付自动化

evidence-uploader 用于合作资料的本地查看和来源保存。当前版本支持人工触发的整份资料查看与字节级归档，资料对象按内容摘要保存，每次领取保留单独回执。自动组织领域资料的能力与人工查看入口分别演进。

## 运行环境

使用 Node.js 22。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 在临时目录实际读取资料、归档并重新核验摘要，退出时清理临时内容。浏览器项目还会启动本地门户和 Chromium 并完成可见页面查看；浏览器在环境准备阶段安装，正式运行不下载。正常演示应在九十秒内结束。

## 本地来源门户

`fixtures/portal/` 是合成业务来源的页面与交互脚本，由 `src/portal.js` 提供本地 HTTP 服务；浏览器功能测试直接操作这些页面。

运行 `npm start -- --port 4173` 后访问终端显示的本地地址，按 Ctrl+C 停止；端口也可由 `PORT` 配置。

## 资料操作

```bash
npm run cli -- inspect fixtures/portal.json
npm run cli -- capture fixtures/portal.json .local/archive
npm run cli -- list .local/archive
```

`capture` 只表示来源字节已保存，不声称领域流程已自动完成。已有查看功能只展示现有资料，不替代业务接纳判断。`scripts/create-fixtures.js` 用于维护者重建合成资料；运行与测试直接读取已提交的资料。

## 浏览器上传助手

`src/assistant.js` 通过真实页面操作交付资料：走文件选择框与页面的上传、续传、刷新、读取按钮，不直接调用门户内部上传接口。完成标准不是浏览器把字节发完，而是门户已接纳且业务记录能按摘要读回核验。

材料以内容摘要与业务用途辨认；临时 upload ID 不进入清单，长期标识是接纳后业务记录给出的 materialId。助手处理的情形：

- 本地文件在等待期间被替换：旧内容标记 `replaced` 并与新内容分开辨认，不混用字节。
- 部分分片过期、会话被服务端撤销或过期：续传补齐或重建会话，恢复后不产生重复业务附件。
- 服务端扫描拒绝：清单留痕原因并转人工，不靠改文件后缀重提（门户按内容识别类型，改名无效）。
- 人工取消：留痕且不自动重提。
- 浏览器重新打开：`reconcile()` 按已接纳、仍隔离、可续传分类后继续。

清单（manifest）逐条记录：`status` 为最终归属，`materialId` 为业务记录 ID，`reason` 为拒绝原因，`manual` 为可人工处理事项，`history` 为过程。

```bash
npm run cli -- assist --portal http://127.0.0.1:4173 --manifest .local/manifest.json --purpose 资质核验 fixtures/certificate.txt
```

门户演练开关（POST `/api/control`，仅接受既有键）：`scanDelayMs` 拖延隔离区扫描、`revokeNext` 撤销下一条上传、`chunkTtlMs` 分片过期、`sessionTtlMs` 会话有效期、`chunkDelayMs` 分片响应延迟、`rejectMarker` 扫描拒绝标记。选文件后页面会显示服务端按内容识别的类型与摘要；接纳后的资料可在页面"业务记录"区读回。

## 目录约定

- `src/domain.js`：现有领域读取和查看接口。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `src/assistant.js`：浏览器上传助手，按业务记录读回确认交付。
- `fixtures/`：本地资料与领域配置。
- `test/`：已有行为的运行验证，使用独立临时目录。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像；浏览器项目使用包含 Chromium 的运行镜像。可执行 `docker build -t evidence-uploader:local .` 后运行 `docker run --rm --network none evidence-uploader:local npm test`。测试中的 HTTP、MQTT 和门户都仅绑定回环地址；不需要第二个容器。构建阶段准备依赖，运行时不安装依赖。
