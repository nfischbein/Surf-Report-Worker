// Surf-Report-Worker — hello world
// Phase 1 step 1: prove the deploy pipe works.
// This Worker ignores the request path and returns a static JSON payload.
// Real routing arrives once the schema is locked.

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const body = {
      service: "surf-report-worker",
      version: "0.0.1",
      status: "ok",
      message: "Hello from the Worker. Routing not yet implemented.",
      received: {
        method: request.method,
        path: url.pathname,
        timestamp: new Date().toISOString(),
      },
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Permissive CORS for now. We'll lock this down when daughter prompts
        // start calling the Worker — but during dev, browser-based curl-equivalents
        // and quick checks shouldn't be blocked.
        "access-control-allow-origin": "*",
      },
    });
  },
};