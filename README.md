# Local image AI search server

用于视频演示的本地 Node.js 后端。服务使用 pi `AgentSession` 维护十分钟内的多轮上下文，调用多模态模型理解图片，并通过 `pi-web-access` 的 `web_search` 获取真实网页搜索结果。

项目只提供一个非流式 JSON 接口，不包含 Web Page、浏览器扩展、Cloudflare Workers、Durable Objects、SQLite、WebSocket 或 SSE。

## 运行要求

- Node.js 22.19 或更高版本。
- 本机 pi 已登录至少一个支持图片的模型。默认使用 `github-copilot/gpt-5.6-sol`。

查看或切换模型：

```bash
cp packages/server/.env.example .env
# 编辑 .env 中的 PI_MODEL=provider/model
```

安装并启动：

```bash
npm install
npm start
```

默认监听 `http://127.0.0.1:8787`。首次出现的 `sessionId` 会自动创建内存会话；每次访问都会刷新十分钟有效期。服务重启后上下文丢失。

## API

```text
POST /v1/sessions/{sessionId}/messages
Content-Type: application/json
```

这是服务提供的唯一 HTTP API。`prompt` 必填，可以附带一张图片。

### 图片 URL

```json
{
  "prompt": "识别图片中的品牌，搜索它的官方网站，并简要介绍。",
  "image": {
    "url": "https://example.com/photo.png"
  }
}
```

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"识别图片中的品牌，搜索它的官方网站。","image":{"url":"https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"}}' \
  http://127.0.0.1:8787/v1/sessions/demo/messages | jq
```

### Base64 图片

支持 JPEG、PNG、WebP，原图最大 5 MiB。Base64 必须是标准编码，不能包含 `data:` 前缀或空白。

```bash
IMAGE_DATA=$(base64 < ./photo.png | tr -d '\n')
jq -n --arg prompt '这是什么？搜索相似结果。' --arg data "$IMAGE_DATA" \
  '{prompt:$prompt,image:{mimeType:"image/png",data:$data}}' | \
  curl -sS -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:8787/v1/sessions/demo/messages | jq
```

后续追问使用同一个 `sessionId`：

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"刚才识别出的公司叫什么？"}' \
  http://127.0.0.1:8787/v1/sessions/demo/messages | jq
```

### 响应

```json
{
  "sessionId": "demo",
  "answer": "这是 Google 标志，官方网站是 https://www.google.com/。",
  "imageAnalysis": {
    "description": "彩色 Google 文字标志",
    "keywords": ["Google", "logo", "search engine"]
  },
  "searchResults": [
    {
      "title": "Google",
      "url": "https://www.google.com/",
      "snippet": "",
      "source": "www.google.com"
    }
  ],
  "searchMode": "live"
}
```

`searchMode` 的值：

- `live`：真实搜索结果。
- `not-used`：Agent 判断本轮不需要搜索。
- `unavailable`：调用了搜索，但供应商未返回结果。
- `demo-fallback`：启用了录屏降级数据；条目的 `source` 也明确标记为 `demo-fallback`。

搜索结果保留各来源内部的原始相关性顺序，并按 `source` 轮询穿插；每个来源最多 2 条，最终最多 10 条，避免单一商城占满结果。

设置 `DEMO_SEARCH_FALLBACK=true` 可以启用录屏安全网。它仅在真实搜索失败时返回一条明确标记的合成结果，不会伪装成真实搜索。

## 错误

错误统一返回：

```json
{
  "error": {
    "code": "IMAGE_TOO_LARGE",
    "message": "Image must not exceed 5 MiB."
  }
}
```

- 参数、Base64、MIME 或图片签名错误：HTTP 400。
- 图片超过 5 MiB 或 JSON 请求超过 8 MiB：HTTP 413。
- Content-Type 不是 `application/json`：HTTP 415。
- 模型或服务内部错误：HTTP 500/502。

## 验证

```bash
npm run typecheck
npm test
npm -w @wa/server run plugin:check
```

`plugin:check` 会实际通过 pi SDK 的 `DefaultResourceLoader` 加载 `pi-web-access`，并确认 `web_search` 已注册。
