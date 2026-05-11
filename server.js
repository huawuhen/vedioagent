import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'state.json');
const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
const mockMode = String(process.env.MOCK_MODE || '').toLowerCase() === 'true' || !process.env.DEEPSEEK_API_KEY;

app.set('trust proxy', 1);
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "media-src": ["'self'", "data:", "blob:", "https:"],
      "connect-src": ["'self'"],
      "font-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "upgrade-insecure-requests": null
    }
  }
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '25mb' }));

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDataDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function mockPickResponse(systemPrompt = '', userMessage = '', opts = {}) {
  const sys = String(systemPrompt);
  const user = String(userMessage);
  if (/优化|改写|提升|prompt 工程师|提示词专家/i.test(sys) || opts.taskKind === 'upgrade') {
    const original = user
      .replace(/##\s*请输出[\s\S]*$/i, '')
      .trim()
      .split(/\n\s*\n/)[0]
      .slice(0, 300);
    return `${original}，电影质感，胶片颗粒感，9:16 竖屏，悬疑氛围，强细节写实，光影层次丰富，冷蓝主光暖色点缀。`;
  }
  if (/剧本拆解|breakdown/i.test(sys)) {
    return JSON.stringify({
      styleGuide: { artStyle: '写实悬疑电影质感', colorTone: '冷蓝偏灰' },
      characters: [],
      scenes: [],
      props: []
    });
  }
  if (/分镜|storyboard/i.test(sys)) {
    return JSON.stringify({
      title: '演示分镜',
      duration: '6 分钟',
      shots: []
    });
  }
  return '收到。基于你的需求，已经为你完成了相应的处理。';
}

async function callDeepSeek({ systemPrompt, userMessage, opts = {} }) {
  const jsonOnlyInstruction = opts.noJsonFormat
    ? ''
    : '\n\n重要：你必须只输出一个合法 JSON 对象，不要输出 Markdown、代码块、解释、前后缀或任何 JSON 之外的内容。';
  const maxTokens = Number(opts.maxTokens || process.env.LLM_MAX_TOKENS || 16384);
  const timeoutMs = Number(opts.timeoutMs || process.env.LLM_TIMEOUT_MS || 180000);
  const body = {
    model: opts.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: (systemPrompt || '') + jsonOnlyInstruction },
      { role: 'user', content: userMessage || '' }
    ],
    temperature: opts.temperature ?? 0.7,
    max_tokens: maxTokens
  };
  if (!opts.noJsonFormat) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await resp.text();
    if (!resp.ok) {
      const message = raw.slice(0, 500) || `DeepSeek request failed with ${resp.status}`;
      const err = new Error(message);
      err.status = resp.status;
      throw err;
    }
    const json = JSON.parse(raw);
    const choice = json.choices?.[0] || {};
    if (choice.finish_reason === 'length') {
      const err = new Error(`模型输出超过当前 token 上限（${maxTokens}），响应被截断。请提高 LLM_MAX_TOKENS，或减少单次拆分镜头数量后重试。`);
      err.status = 502;
      throw err;
    }
    let text = choice.message?.content || '';
    if (!opts.noJsonFormat) text = extractJsonText(text);
    return {
      text,
      usage: json.usage || null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  try {
    JSON.parse(raw);
    return raw;
  } catch (_) {
    // continue
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch (_) {
      // continue
    }
  }
  const firstObj = raw.indexOf('{');
  const lastObj = raw.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    const sliced = raw.slice(firstObj, lastObj + 1);
    try {
      JSON.parse(sliced);
      return sliced;
    } catch (_) {
      // continue
    }
  }
  return raw;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, mockMode, provider });
});

app.get('/api/config', (_req, res) => {
  res.json({
    mockMode,
    provider,
    persistence: 'server-file',
    maxUploadMb: Math.floor((Number.parseInt(process.env.JSON_LIMIT || '25mb', 10) || 25))
  });
});

app.get('/api/state', async (_req, res, next) => {
  try {
    res.json({ state: await readJson(stateFile) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/state', async (req, res, next) => {
  try {
    await writeJsonAtomic(stateFile, {
      ...req.body,
      savedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/state', async (_req, res, next) => {
  try {
    await fs.rm(stateFile, { force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/llm', async (req, res, next) => {
  try {
    if (mockMode) {
      return res.json({
        text: mockPickResponse(req.body.systemPrompt, req.body.userMessage, req.body.opts || {}),
        usage: null,
        mock: true
      });
    }
    if (provider !== 'deepseek') {
      return res.status(400).json({ error: `Unsupported LLM_PROVIDER: ${provider}` });
    }
    const result = await callDeepSeek(req.body || {});
    res.json({ ...result, mock: false });
  } catch (err) {
    next(err);
  }
});

app.use(express.static(__dirname, {
  extensions: ['html'],
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'AbortError' ? 504 : 500);
  res.status(status).json({
    error: err.message || 'Internal Server Error'
  });
});

app.listen(port, async () => {
  await ensureDataDir();
  console.log(`Video Agent listening on :${port} (mockMode=${mockMode})`);
});
