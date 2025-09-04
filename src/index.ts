// Alternative approach: Pass projectId in the request to the DO
export { UserWebSocketBridge } from './websocket-bridge';

export interface Env {
  USER_WEBSOCKET_BRIDGE: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
        
    // Add CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Extract projectId from URL parameters
    const projectId = url.searchParams.get('projectId');
    
    
    if (!projectId) {
      console.error('Worker: Missing projectId parameter');
      return new Response(JSON.stringify({
        error: 'Missing projectId parameter',
        message: 'Please provide ?projectId=your-project-id in the URL',
        receivedUrl: url.toString()
      }), { 
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
        
    try {
      // Create a Durable Object ID based on the projectId
      const durableObjectId = env.USER_WEBSOCKET_BRIDGE.idFromName(projectId);
      const durableObjectStub = env.USER_WEBSOCKET_BRIDGE.get(durableObjectId);
      
      
      // Create a new request with projectId in headers as backup

      const headers = new Headers(request.headers);
      headers.set("X-Project-Id", projectId);

      const newRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body
      });
      
      // Forward the request to the user-specific Durable Object
      const response = await durableObjectStub.fetch(newRequest);
            
      // Handle WebSocket upgrade responses (status 101) specially
      if (response.status === 101) {
        console.log(`Worker: WebSocket upgrade successful, returning response directly`);
        // For WebSocket upgrades, return the response as-is
        return response;
      }
      
      // For non-WebSocket responses, add CORS headers
      const responseHeaders = new Headers();
      
      // Copy existing headers
      response.headers.forEach((value, key) => {
        responseHeaders.set(key, value);
      });
      
      // Add CORS headers
      Object.entries(corsHeaders).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });
      
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
      
      return newResponse;
      
    } catch (error:any) {
      console.error(`Worker: Error routing to Durable Object for project "${projectId}":`, error);
      
      return new Response(JSON.stringify({
        error: 'Failed to route to Durable Object',
        projectId: projectId,
        details: error.message
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
};