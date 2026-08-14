import { serve } from "https://deno.land/std/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

/** 上游 API 超时（ms）：主引擎 8s，备用引擎 6s */
const UPSTREAM_TIMEOUT_MS = 8000;
const FALLBACK_TIMEOUT_MS = 6000;

/** 语言代码映射：前端代码 → MyMemory 备用引擎代码 */
const LANG_MAP: Record<string, string> = {
  "zh": "zh-CN",
  "en": "en-GB",
  "jp": "ja",
  "kor": "ko",
  "fra": "fr",
  "de": "de",
  "spa": "es",
  "ru": "ru",
};

function respond(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: CORS_HEADERS,
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 主引擎：appmiaoda 网关翻译 */
async function translatePrimary(
  q: string,
  from: string,
  to: string,
  apiKey: string,
): Promise<{ from: string; to: string; trans_result: Array<{ src: string; dst: string }> } | null> {
  try {
    const upstream = await fetchWithTimeout(
      "https://app-bo4w33bsdqm9-api-e94GZ5j0PWpa-gateway.appmiaoda.com/rpc/2.0/mt/texttrans/v1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          "X-Gateway-Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ q, from, to }),
      },
      UPSTREAM_TIMEOUT_MS,
    );

    if (upstream.status === 429 || upstream.status === 402) {
      console.warn(`[text-translation] 上游配额受限: ${upstream.status}，尝试备用引擎`);
      return null;
    }
    if (!upstream.ok) {
      console.warn(`[text-translation] 上游异常: ${upstream.status}，尝试备用引擎`);
      return null;
    }

    const data = await upstream.json();
    if (data?.error_code) {
      console.warn(`[text-translation] 上游业务错误: ${data.error_code} ${data.error_msg ?? ""}`);
      return null;
    }
    // 兼容两种返回形态：{result:{from,to,trans_result}} 或 {from,to,trans_result}
    const result = data?.result ?? data;
    if (result?.trans_result && Array.isArray(result.trans_result)) {
      return result;
    }
    return null;
  } catch (e) {
    console.warn("[text-translation] 主引擎请求失败:", e?.message ?? e);
    return null;
  }
}

/** 备用引擎：MyMemory 免费翻译（无需密钥，限 q<=500 字节/次） */
async function translateFallback(
  q: string,
  to: string,
): Promise<{ from: string; to: string; trans_result: Array<{ src: string; dst: string }> } | null> {
  const langTo = LANG_MAP[to] ?? "en";
  const pair = `Autodetect|${langTo}`;

  // MyMemory 单次上限 500 字节：按行拆分，每行单独翻译（最多 8 行，防止滥用）
  const lines = q.split("\n").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8);
  if (lines.length === 0) return null;

  const trans_result: Array<{ src: string; dst: string }> = [];
  try {
    for (const line of lines) {
      const enc = encodeURIComponent(line).slice(0, 480);
      const resp = await fetchWithTimeout(
        `https://api.mymemory.translated.net/get?q=${enc}&langpair=${encodeURIComponent(pair)}`,
        { method: "GET" },
        FALLBACK_TIMEOUT_MS,
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      const dst: string | undefined = data?.responseData?.translatedText;
      if (dst && dst.trim()) {
        trans_result.push({ src: line, dst });
      }
    }
    if (trans_result.length === 0) return null;
    return { from: "auto", to, trans_result };
  } catch (e) {
    console.warn("[text-translation] 备用引擎请求失败:", e?.message ?? e);
    return null;
  }
}

serve(async (req: Request): Promise<Response> => {
  // CORS 预检请求
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // --- 解析客户端请求 ---
  let q: string;
  let from: string;
  let to: string;
  try {
    const body = await req.json();
    q = body.q;
    from = body.from;
    to = body.to;
    if (!q) throw new Error("Missing q");
    if (!from) throw new Error("Missing from");
    if (!to) throw new Error("Missing to");
  } catch {
    return respond(400, { error: "Invalid request body" });
  }

  // --- 主引擎（需密钥）---
  const apiKey = Deno.env.get("INTEGRATIONS_API_KEY");
  if (apiKey) {
    const primary = await translatePrimary(q, from, to, apiKey);
    if (primary) {
      return respond(200, { result: primary });
    }
  } else {
    console.warn("[text-translation] INTEGRATIONS_API_KEY 未配置，直接使用备用引擎");
  }

  // --- 备用引擎（无密钥）---
  const fallback = await translateFallback(q, to);
  if (fallback) {
    return respond(200, { result: fallback });
  }

  return respond(502, { error: "Translation service unavailable" });
});