# VedioAgent

短剧生产工作流 AI 协作工具，覆盖“剧本拆解 → 分镜脚本 → 角色/场景生成 → 视频合成”的完整创作流程。

当前版本已经从纯前端演示原型升级为可 Docker 部署的生产化骨架：

- 前端：单页 HTML / Vanilla JavaScript / Tailwind CDN / Lucide Icons
- 后端：Node.js / Express
- 模型：后端代理 DeepSeek，API Key 不暴露到浏览器
- 持久化：Docker volume 中的 `/app/data/state.json`
- 部署：Docker / Docker Compose

> 说明：文本类技能已经接入真实 LLM 代理；图片/视频生成仍保留占位资源。要商用完整图像/视频生成，需要继续接入对应供应商的异步任务 API 和对象存储。

## 功能

- 剧本拆解：提取风格、角色、场景、道具，并生成图像提示词。
- 分镜脚本：按场景拆镜头，输出景别、机位、动作、对白、音效和提示词。
- 文件管理：项目级资产仓库、文件夹、详情预览、批注和下载。
- 文档上传：支持上传文本、Markdown、JSON、CSV、PDF、DOC/DOCX、图片、视频、音频等参考素材。
- 服务端模型代理：浏览器只请求 `/api/llm`，真实模型密钥只在服务端 `.env` 中配置。
- 状态持久化：项目、会话、资产索引、收藏提示词等通过 `/api/state` 保存。

## 快速部署

### 1. 准备服务器

推荐配置：

- Linux 服务器，2C/2G 起步
- Docker 24+
- Docker Compose v2+
- 开放端口：`3000`，或由 Nginx/Caddy 反代到 HTTPS 域名

安装 Docker 可参考官方文档：

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker
sudo systemctl start docker
```

### 2. 拉取代码

```bash
git clone https://github.com/huawuhen/vedioagent.git
cd vedioagent
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
PORT=3000

# true 为演示模式，不消耗模型额度；生产使用请改为 false
MOCK_MODE=false

LLM_PROVIDER=deepseek
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_API_KEY=sk-你的DeepSeekKey

JSON_LIMIT=25mb
```

如果只想先验证页面，不调用真实模型，可以保持：

```env
MOCK_MODE=true
```

### 4. 启动服务

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f vedioagent
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

正常返回示例：

```json
{"ok":true,"mockMode":false,"provider":"deepseek"}
```

访问：

```text
http://你的服务器IP:3000
```

## 反向代理 HTTPS

生产环境建议使用 Nginx 或 Caddy 做 HTTPS。

### Nginx 示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置证书可使用 Certbot：

```bash
sudo certbot --nginx -d your-domain.com
```

### Caddy 示例

```caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:3000
}
```

## 数据持久化和备份

`docker-compose.yml` 使用命名 volume 保存状态：

```text
vedioagent_data:/app/data
```

容器内状态文件：

```text
/app/data/state.json
```

备份：

```bash
docker run --rm \
  -v vedioagent_vedioagent_data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/vedioagent-data.tgz -C /data .
```

恢复：

```bash
docker compose down
docker run --rm \
  -v vedioagent_vedioagent_data:/data \
  -v "$PWD":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/vedioagent-data.tgz -C /data"
docker compose up -d
```

## 更新部署

```bash
git pull
docker compose up -d --build
```

如果只改了环境变量：

```bash
docker compose up -d
```

停止服务：

```bash
docker compose down
```

停止并删除数据卷：

```bash
docker compose down -v
```

## 本地开发

```bash
npm install
cp .env.example .env
npm run dev
```

打开：

```text
http://localhost:3000
```

常用检查：

```bash
node --check server.js
node --check app.js
curl http://localhost:3000/api/config
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `MOCK_MODE` | `true` | 是否使用演示模式 |
| `LLM_PROVIDER` | `deepseek` | 模型供应商，目前支持 DeepSeek |
| `DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek 模型名 |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek API Key，只在服务端使用 |
| `DATA_DIR` | `/app/data` | 状态文件目录 |
| `JSON_LIMIT` | `25mb` | API JSON 请求体上限 |

## 生产化建议

当前版本适合 MVP、内测和单机部署。正式商用建议继续升级：

- 数据库：把 JSON 文件状态迁移到 PostgreSQL。
- 对象存储：上传剧本、图片、视频放到 S3 / R2 / OSS / MinIO。
- 任务队列：图片/视频生成改为异步 job，使用 Redis + BullMQ。
- 鉴权：加入登录、团队、项目权限和审计日志。
- 安全：上传文件扫描、速率限制、模型成本限额。
- 可观测性：接入结构化日志、错误追踪、指标和告警。
