export { UserWebSocket } from './websocket-bridge';

export interface Env {
  USER_WEBSOCKET: DurableObjectNamespace;
  // Add environment variables if you have any
  // ENVIRONMENT?: string;
  // API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Enhanced logging with more details
    console.log('=== MAIN WORKER ===');
    console.log('Request URL:', url.toString());
    console.log('Method:', request.method);
    console.log('User-Agent:', request.headers.get('User-Agent'));
    console.log('Origin:', request.headers.get('Origin'));
    
    // More comprehensive CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol',
      'Access-Control-Expose-Headers': 'Content-Length, Date, Server',
      'Access-Control-Max-Age': '86400', // 24 hours
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      console.log('Worker: Handling CORS preflight');
      return new Response(null, { 
        status: 204,
        headers: corsHeaders 
      });
    }

    // Add health check endpoint at worker level
    if (url.pathname === '/health' && !url.searchParams.get('projectId')) {
      return new Response(JSON.stringify({
        status: 'healthy',
        worker: 'main',
        timestamp: Date.now(),
        version: '1.0.0'
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
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
          example: `${url.origin}/websocket?projectId=your-project&type=runtime`
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }

    // Validate projectId format (optional but recommended)
    if (!isValidProjectId(projectId)) {
      console.error(`Worker: Invalid projectId format: "${projectId}"`);
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
      // Route to correct Durable Object using projectId
      const durableObjectId = env.USER_WEBSOCKET.idFromName(projectId);
      console.log(`Worker: Generated DO ID for project "${projectId}": ${durableObjectId.toString()}`);

      const durableObjectStub = env.USER_WEBSOCKET.get(durableObjectId);
      console.log('Worker: Got DO stub, forwarding request...');

      // Forward the request to the Durable Object
      const response = await durableObjectStub.fetch(request);
      console.log(`Worker: DO Response status: ${response.status}`);

      // Special handling for WebSocket upgrade (status 101)
      if (response.status === 101) {
        console.log(`Worker: WebSocket upgrade successful for project ${projectId}`);
        // For WebSocket upgrades, return response as-is
        return response;
      }

      // For regular HTTP responses, add CORS headers
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      // Clone the response with new headers
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

    } catch (error: any) {
      console.error(`Worker: Error routing to DO for project "${projectId}":`, error);
      console.error('Worker: Error stack:', error.stack);
      
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

  // Optional: Add scheduled handler if you need cron jobs
  // async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  //   console.log('Scheduled event triggered:', event.cron);
  //   // Add any scheduled tasks here
  // },

  // Optional: Add queue handler if you use queues
  // async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
  //   console.log('Queue batch received:', batch.messages.length);
  //   // Process queue messages
  // },
};

// Helper function to validate projectId format
function isValidProjectId(projectId: string): boolean {
  // Allow alphanumeric characters, hyphens, and underscores
  // Length between 1 and 64 characters
  const regex = /^[a-zA-Z0-9_-]{1,64}$/;
  return regex.test(projectId);
}