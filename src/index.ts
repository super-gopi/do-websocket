export { UserWebSocket } from './websocket-bridge';
export interface Env {
  USER_WEBSOCKET: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Basic CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Extract projectId from URL
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      console.error('Worker: Missing projectId parameter');
      return new Response(
        JSON.stringify({
          error: 'Missing projectId parameter',
          message: 'Please provide ?projectId=your-project-id in the URL',
          receivedUrl: url.toString(),
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    try {
      // Route to correct Durable Object
      const durableObjectId = env.USER_WEBSOCKET.idFromName(projectId);
      const durableObjectStub = env.USER_WEBSOCKET.get(durableObjectId);

      // Forward the same request directly
      const response = await durableObjectStub.fetch(request);

      // Special handling for WebSocket upgrade (status 101)
      if (response.status === 101) {
        console.log(`Worker: WebSocket upgrade successful for project ${projectId}`);
        return response;
      }

      // Add CORS headers for normal HTTP responses
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error: any) {
      console.error(`Worker: Error routing to DO for project "${projectId}":`, error);
      return new Response(
        JSON.stringify({
          error: 'Failed to route to Durable Object',
          projectId,
          details: error.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  },
};
