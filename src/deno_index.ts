const getContentType = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
};

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  
  const url = new URL(req.url);
  const targetUrl = `wss://generativelanguage.googleapis.com${url.pathname}${url.search}`;
  
  console.log('Target URL:', targetUrl);
  
  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);
  
  targetWs.onopen = () => {
    console.log('Connected to Gemini');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    console.log('Client message received');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    console.log('Gemini message received');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    console.log('Client connection closed');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    console.log('Gemini connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    console.error('Gemini WebSocket error:', error);
  };

  return response;
}

async function handleAPIRequest(req: Request): Promise<Response> {
  try {
    const worker = await import('./api_proxy/worker.mjs');
    return await worker.default.fetch(req);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = (error as { status?: number }).status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

import { apiRoutes } from "./apis/apis.ts";   // ← 引入

async function handleRequest(req: Request): Promise<Response> {
  const { method } = req; // 调用方法（GET/POST/OPTION等）
  const url = new URL(req.url);
  console.info('Request URL:', req.url, " and request type:", method);

  // WebSocket 处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  if (url.pathname.endsWith("/chat/completions") ||
      url.pathname.endsWith("/embeddings") ||
      url.pathname.endsWith("/models")) {
    return handleAPIRequest(req);
  }

  if (req.method === "OPTIONS") { // 前后端如果不在同域，需要204，否则CORS错误
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // ─────────────── 新增：自定义 API 路由 ───────────────
  if (url.pathname.startsWith("/api/")) {   // 或严格等于 url.pathname
    const handler = apiRoutes?.[url.pathname];   // 加 ? 可选链，防止崩溃
    if (req.method !== "POST" && req.method !== "GET") {
     return new Response("Method Not Allowed", { status: 405 });
    }
    if (handler) {
      try {
        return await handler(req, url);
      } catch (err) {
        console.error("API handler failed:", err);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    return Response.json({ error: "API endpoint not found" }, { status: 404 });
  }

  // 静态文件处理，这里只允许GET请求
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    let filePath = url.pathname;
    if (filePath === '/' || filePath === '/index.html') {
      filePath = '/index.html';
    }
    const fullPath = `${Deno.cwd()}/src/static${filePath}`;
    const file = await Deno.readFile(fullPath);
    const contentType = getContentType(filePath);
    return new Response(file, {
      headers: {
        'content-type': `${contentType};charset=UTF-8`,
      },
    });
  } catch (e) {
    console.error('Error details:', e);
    return new Response('Not Found', { 
      status: 404,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

//Deno.serve(handleRequest, { port: 3008 }); 
Deno.serve(handleRequest); 
