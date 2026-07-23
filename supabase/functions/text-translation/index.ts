import { serve } from "https://deno.land/std/http/server.ts";

serve(async (req: Request): Promise<Response> => {
  // CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }});
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
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- 注入平台密钥（禁止暴露到前端）---
  const apiKey = Deno.env.get("INTEGRATIONS_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- 调用上游 API ---
  const upstream = await fetch(
    "https://app-bo4w33bsdqm9-api-e94GZ5j0PWpa-gateway.appmiaoda.com/rpc/2.0/mt/texttrans/v1",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "X-Gateway-Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ q, from, to }),
    }
  );

  // 透传配额超限和余额不足错误
  if (upstream.status === 429 || upstream.status === 402) {
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: { 
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': '*'
      },
    });
  }

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: `Upstream error: ${upstream.status}` }),
      { status: 502, headers: { 
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': '*'
      } }
    );
  }

  const data = await upstream.json();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 
      "Content-Type": "application/json",
      'Access-Control-Allow-Origin': '*'
    },
  });
});