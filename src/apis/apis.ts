type ApiHandler = (req: Request, url: URL) => Promise<Response> | Response;
export const apiRoutes: Record<string, ApiHandler> = { // 自定义结构，把方法和tool调用map起来
  "/api/weather": async (req, url) => {
    const city = url.searchParams.get("city") || "Shanghai";    
    // 这里放真实逻辑，例如调用第三方天气 API - 密钥只存在服务器端，前端看不到
    const apiKey = Deno.env.get("OPENWEATHER_API_KEY") || "your-key-here";
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`;

    try {
      const res = await fetch(weatherUrl);
      const data = await res.json();

      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.message || "Weather API error" }), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        city: data.name,
        temp: data.main.temp,
        feels_like: data.main.feels_like,
        description: data.weather[0]?.description,
        fetchedAt: new Date().toISOString(),
      }), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Failed to fetch weather" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  "/api/hello": () => {
    return new Response(JSON.stringify({
      message: "Hello from server! 🔥",
      time: new Date().toISOString(),
      //env: Deno.env.get("DENO_ENV") || "development",
    }), {
      headers: { "content-type": "application/json" },
    });
  },

  // 例如一个需要鉴权的接口
  "/api/secret": (req) => {
    const auth = req.headers.get("authorization");
    console.info("in secret api loop: ", auth);
    if (auth !== "Bearer xyz123") {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("This is very secret content", { status: 200 });
  },
};
