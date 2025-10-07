export { UserWebSocket } from './websocket-bridge';
export { Broadcaster } from './broadcaster/broadcaster';

export interface Env {
  USER_WEBSOCKET: DurableObjectNamespace;
  BROADCASTER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    console.log('=== MAIN WORKER ===');
    console.log('Request URL:', url.toString());
    console.log('Method:', request.method);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol',
      'Access-Control-Expose-Headers': 'Content-Length, Date, Server',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Health check endpoint
    if (url.pathname === '/health' && !url.searchParams.get('projectId') && !url.searchParams.get('userId')) {
      return new Response(JSON.stringify({
        status: 'healthy',
        worker: 'main',
        timestamp: Date.now(),
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Check if this is a broadcaster request
    const userId = url.searchParams.get('userId');
    if (userId) {
    //   if (!isValidId(userId)) {
    //     return new Response(
    //       JSON.stringify({
    //         error: 'Invalid userId format',
    //         message: 'UserId must be alphanumeric with optional hyphens and underscores',
    //         receivedUserId: userId
    //       }),
    //       {
    //         status: 400,
    //         headers: { 'Content-Type': 'application/json', ...corsHeaders },
    //       }
    //     );
    //   }

      try {
        const durableObjectId = env.BROADCASTER.idFromName(userId);
        const durableObjectStub = env.BROADCASTER.get(durableObjectId);
        const response = await durableObjectStub.fetch(request);

        if (response.status === 101) {
          return response;
        }

        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          newHeaders.set(key, value);
        });

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });

      } catch (error: any) {
        return new Response(
          JSON.stringify({
            error: 'Failed to route to Broadcaster',
            userId,
            details: error.message,
            timestamp: Date.now()
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          }
        );
      }
    }

    // Original UserWebSocket logic
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
      return new Response(
        JSON.stringify({
          error: 'Missing projectId or userId parameter',
          message: 'Please provide ?projectId=your-project-id for UserWebSocket or ?userId=your-user-id for Broadcaster',
          receivedUrl: url.toString(),
          examples: [
            `${url.origin}/websocket?projectId=your-project&type=runtime`,
            `${url.origin}/websocket?userId=your-user`
          ]
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    if (!isValidId(projectId)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid projectId format',
          message: 'ProjectId must be alphanumeric with optional hyphens and underscores',
          receivedProjectId: projectId
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    try {
      const durableObjectId = env.USER_WEBSOCKET.idFromName(projectId);
      const durableObjectStub = env.USER_WEBSOCKET.get(durableObjectId);
      const response = await durableObjectStub.fetch(request);

      if (response.status === 101) {
        return response;
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

    } catch (error: any) {
      return new Response(
        JSON.stringify({
          error: 'Failed to route to Durable Object',
          projectId,
          details: error.message,
          timestamp: Date.now()
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  },
};

function isValidId(id: string): boolean {
  const regex = /^[a-zA-Z0-9_-]{1,64}$/;
  return regex.test(id);
}
