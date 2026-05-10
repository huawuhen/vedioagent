# Video Agent Demo

短剧生产工作流 AI 协作工具的 HTML 原型演示。

完整展示从**剧本拆解 → 分镜脚本 → 角色场景生成 → 视频合成**的 4 步闭环工作流。

## 在线体验

→ [Live Demo](https://bruce-agnet.github.io/vedioagent-demo/)

## 演示路径

打开后默认进入"短剧 S1E1"项目。建议依次浏览：

1. **会话1 · 剧本拆解** — 上传剧本 → AI 拆出风格 / 角色 / 场景 / 道具，每条带可直接用的图像 prompt
2. **会话2 · 分镜脚本** — 引用拆解结果 → AI 拆出 14 个镜头，每镜头含 videoPrompt
3. **会话3 · 角色场景生成** — 复用上一步的 imagePrompt → 生成角色图、场景图（5 角色 / 7 场景 / 3 道具）
4. **会话4 · 视频生成** — 引用前两步的图 + videoPrompt → 生成视频片段（含 storyboard 引用）

右侧文件管理面板包含完整的资产仓库。点击右上 ↗ 进入文件管理最大化模式，详情面板会以"列表 + 详情"形式并排展示。

## 演示模式说明

- **演示数据**：所有 AI 响应均为预录数据，无真实 LLM 调用，无网络请求
- **占位资源**：图片/视频均为 SVG 占位（实际产品中由 AI 生成）
- **重置数据**：左下角"Bruce"头像 → "恢复初始状态"，清除本地所有自定义数据，返回演示原始状态

## 技术栈

- 单页 HTML / Vanilla JavaScript / Tailwind CDN / Lucide Icons
- Node.js / Express 后端（生产部署版）
- Docker / Docker Compose
- Demo 数据在 `mock/data.js`，用户状态由后端 `/api/state` 持久化

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
```

访问 `http://localhost:3000`。

连接真实 DeepSeek 时，在 `.env` 中设置：

```env
MOCK_MODE=false
DEEPSEEK_API_KEY=sk-你的-key
```

更多生产部署建议见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

## 演示话术（5-7 分钟）

1. (1 min) 介绍主线："短剧 S1E1 一集完整生产流程"
2. (1 min) 会话1 剧本拆解：展示上传 → V1 → 批注 → V2 迭代轨迹
3. (1 min) 会话2 分镜脚本：展示 V1 → 节奏修订 → V2，14 镜头每镜头含 videoPrompt
4. (1.5 min) 会话3 角色场景生成：5 角色 + 7 场景 + 3 道具，使用 ✨ AI 优化展示 prompt 改写
5. (1.5 min) 会话4 视频生成：展示视频引用前面图作 reference + storyboard 镜号
6. (0.5 min) 文件管理面板：演示三列模式（树 / 列表 / 详情）+ 跨会话切换
