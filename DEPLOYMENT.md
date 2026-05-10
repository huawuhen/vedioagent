# 生产部署说明

这个版本把原来的纯静态 mock 原型升级为一个可 Docker 部署的最小生产骨架：

- 前端仍复用现有 `index.html` / `app.js` UI。
- Node/Express 后端托管静态文件，并提供 API。
- `/api/llm` 在服务端代理 DeepSeek，API Key 不再暴露到浏览器。
- `/api/state` 把项目、会话、文件夹、资产索引等状态保存到 Docker volume。
- `/healthz` 用于容器健康检查。

## 快速启动

```bash
cp .env.example .env
docker compose up -d --build
```

访问：

```text
http://localhost:3000
```

查看健康状态：

```bash
curl http://localhost:3000/healthz
```

## 连接真实 DeepSeek

编辑 `.env`：

```env
MOCK_MODE=false
LLM_PROVIDER=deepseek
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_API_KEY=sk-你的-key
```

重启：

```bash
docker compose up -d --build
```

注意：当前生产化版本已经把“文本类技能”接到后端 LLM 代理；图片/视频生成仍保留原型占位逻辑。要真正商用图片/视频生成，需要继续接入对应供应商的异步任务 API，并把结果写入对象存储。

## 数据持久化

`docker-compose.yml` 使用命名 volume：

```text
vedioagent_data:/app/data
```

状态文件位置：

```text
/app/data/state.json
```

备份：

```bash
docker run --rm -v vedioagent-demo_vedioagent_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/vedioagent-data.tgz -C /data .
```

## 推荐生产拓扑

小团队内测可以直接使用当前 Docker Compose。

正式对外商用建议继续升级：

- 反向代理：Nginx / Caddy / Traefik，负责 HTTPS、压缩、访问日志。
- 数据库：把 `/api/state` 从 JSON 文件迁到 PostgreSQL。
- 对象存储：把上传剧本、生成图片、生成视频放到 S3 / R2 / OSS / MinIO。
- 任务队列：图片/视频生成改为异步 job，使用 Redis + BullMQ 或类似方案。
- 鉴权：加入登录、团队、项目权限和审计日志。
- 安全：上传文件扫描、速率限制、CSP 白名单、模型成本限额。
- 可观测性：接入结构化日志、错误追踪、指标和告警。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内服务端口 |
| `MOCK_MODE` | `true` | 是否使用安全 mock 模式 |
| `LLM_PROVIDER` | `deepseek` | 当前支持 DeepSeek |
| `DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek 模型名 |
| `DEEPSEEK_API_KEY` | 空 | 服务端模型密钥 |
| `DATA_DIR` | `/app/data` | 状态文件目录 |
| `JSON_LIMIT` | `25mb` | API JSON 请求体上限 |

## 本地开发

```bash
npm install
cp .env.example .env
npm run dev
```

然后打开：

```text
http://localhost:3000
```
