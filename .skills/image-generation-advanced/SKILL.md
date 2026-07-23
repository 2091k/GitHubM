---
name: image-generation-advanced
description: 高级图片生成与编辑，支持文生图、图生图、多图合成，异步任务轮询。需要 AI 生成图片、对图片做内容编辑或风格转换时优先使用该工具。
license: MIT
---

## 能力概述

图片生成与编辑（高级版）提供高质量的图片生成与精细编辑能力，支持以下三种模式：

| 模式 | 说明 |
|------|------|
| 文生图 | 仅提供文字提示词，生成对应图片 |
| 图生图 | 上传一张图片 + 提示词，进行风格转换或编辑 |
| 多图生图 | 上传多张图片 + 提示词，智能合成 |

**两个接口（异步任务模型）：**

| 接口 | 方法 | Endpoint |
|------|------|----------|
| 提交任务 | POST | `https://app-bo4w33bsdqm9-api-ra5EZDjVKkXa-gateway.appmiaoda.com/image-generation/submit` |
| 查询状态 | POST/GET | `https://app-bo4w33bsdqm9-api-VaOwP2jDmAga-gateway.appmiaoda.com/image-generation/task` |

任务状态：`PENDING` → `PROCESSING` → `SUCCESS` / `FAILED`

完成后返回 `imageUrl`（CDN 链接，建议转存至 Supabase Storage 保持持久性）。

**平台差异：**

| 平台 | 查询接口调用方式 | 说明 |
|------|----------------|------|
| Web | POST body `{ taskId }` | 标准用法 |
| MiniProgram | GET 查询参数 `?taskId=...` | Miaoda 代理会丢弃小 POST body，改用 GET 参数 |
| App | POST body `{ taskId }` | 同 Web；图片上传需使用 `expo/fetch` + ArrayBuffer 方式转存至 Supabase Storage |

详见 `references/image-generation-api.md`。

---

## 使用前决策

调用本工具前，先判断场景是否真的需要 AI 生成：

| 场景 | 推荐方案 |
|------|---------|
| 根据文字描述生成全新图片 | ✅ 本工具（文生图） |
| 上传图片 + 提示词做风格转换或内容编辑 | ✅ 本工具（图生图） |
| 多张图片智能合成新图 | ✅ 本工具（多图生图） |
| 图片内容审核 / 质量评分 | ❌ 改用视觉模型直接分析，无需生成 |

---

## Prompt 编写规范

底层模型（Gemini Imagen 系列）**对英文提示词的输出质量明显优于中文**，请始终先将用户需求翻译/改写为英文后再提交 API。

**写作原则：**
- 使用描述句，直接描述目标画面，而非告诉模型"帮我生成……"
- 具体优于抽象：`"a ginger cat sitting in a sunlit garden"` 好于 `"可爱的猫"`
- 避免否定词：不写 `"no background"`，改写 `"isolated on pure white background"`
- 末尾加质量修饰词提升细节：`high quality`, `detailed`, `8k`, `photorealistic`

**文生图模板：**

```
[Subject], [Action/Pose/State], [Scene/Environment], [Lighting], [Style], [Quality]
```

示例：
```
A golden retriever puppy, sitting and looking up curiously, in a cozy living room with warm afternoon lighting, watercolor illustration style, high quality, detailed
```

**图生图额外建议：**
- 先描述希望**保留**的内容，再描述希望**改变**的内容
- 风格迁移时明确目标风格，例如 `"convert to anime style"` 或 `"oil painting style"`

---

## 生成期用法（Agent 直接调用）

适用于 Agent 脚本直接调用，密钥由平台注入。

> **在调用 API 之前，先将用户需求翻译/改写为英文提示词**，底层 Gemini Imagen 系列模型对英文输入的图像质量明显优于中文。

```typescript
const apiKey = process.env["INTEGRATIONS_API_KEY"]!;

/** 提交图片生成任务（文生图） */
async function submitImageGeneration(prompt: string): Promise<string> {
  const response = await fetch(
    "https://app-bo4w33bsdqm9-api-ra5EZDjVKkXa-gateway.appmiaoda.com/image-generation/submit",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const json = await response.json();
  if (json.status !== 0) throw new Error(`API error: ${json.message}`);
  return json.data.taskId;
}

/** 查询任务状态 */
async function queryTaskStatus(taskId: string): Promise<{
  status: string;
  imageUrl?: string;
  error?: { code: string; message: string };
}> {
  const response = await fetch(
    "https://app-bo4w33bsdqm9-api-VaOwP2jDmAga-gateway.appmiaoda.com/image-generation/task",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ taskId }),
    }
  );
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const json = await response.json();
  if (json.status !== 0) throw new Error(`API error: ${json.message}`);
  return {
    status: json.data.status,
    imageUrl: json.data.result?.imageUrl,
    error: json.data.error,
  };
}

/** 完整异步工作流：提交 → 轮询 → 返回图片 URL */
async function generateImage(prompt: string): Promise<string> {
  const taskId = await submitImageGeneration(prompt);

  const POLL_INTERVAL_MS = 7000;
  const TIMEOUT_MS = 20 * 60 * 1000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await queryTaskStatus(taskId);
    if (result.status === "SUCCESS") return result.imageUrl!;
    if (result.status === "FAILED") {
      throw new Error(`Task failed: ${JSON.stringify(result.error)}`);
    }
    // PENDING / PROCESSING → keep polling
  }
  throw new Error(`Task ${taskId} timed out after 20 minutes`);
}
```

**空间位置描述（生成期 Prompt 增强）：**

在提示词中加入空间位置词可显著提高构图准确性：

| 位置关键词 | 说明 | 示例 |
|-----------|------|------|
| `centered` / `in the center` | 主体居中 | `"a red rose, centered, white background"` |
| `in the top-left / bottom-right corner` | 角落定位 | `"logo in the top-left corner"` |
| `in the foreground / background` | 前景/背景层次 | `"flowers in the foreground, mountains in the background"` |
| `on the left side / right side` | 左右分布 | `"person on the left, product on the right"` |
| `filling the entire frame` | 占满画面 | `"texture filling the entire frame"` |

**生成期文件下载（必须执行）：**

生成接口返回的 URL 是 CDN 临时链接，在生成期（Agent 直接调用场景）获得 URL 后，**必须立即使用 Bash 工具将文件下载到本地**，以便用户查看结果。

```bash
curl -L -o <本地路径> "<生成的文件 URL>"
```

**完整生成期工作流（含下载步骤）：**

1. 调用生成函数获取文件 URL
2. 使用 Bash 工具执行 `curl -L -o <本地路径> "<url>"` 将文件下载到本地
3. 告知用户文件已保存到对应路径

> **注意**：上游 CDN 链接有时效性，应在获得 URL 后立即下载，不要延迟。

完整参数说明（含图生图、多图合成）详见 `references/image-generation-api.md`。

---

## 生成后用法（应用内通过 Edge Function 调用）

应用内通过 Edge Function 代理调用，密钥不暴露给前端。

**平台实现差异：**

| 平台 | Edge Function 差异 | 前端调用方式 |
|------|-------------------|-------------|
| Web | 查询接口用 POST body | `supabase.functions.invoke` |
| MiniProgram | 查询接口用 GET + URL 参数（绕过代理 body 丢失问题） | `supabase.functions.invoke("query-task?taskId=...")` with `method: "GET"` |

完整 Edge Function 代码和前端调用代码详见 `references/image-generation-api.md`。

