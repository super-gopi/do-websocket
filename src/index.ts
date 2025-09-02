import { WebSocketBridge } from './websocket-bridge';
import { Env } from './types';

export { WebSocketBridge };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
        },
      });
    }

    // Route to Durable Object
    if (url.pathname.startsWith('/websocket') || 
        url.pathname.startsWith('/status') || 
        url.pathname.startsWith('/users') ||
        url.pathname.startsWith('/health')) {
      
      // Use single instance for all users - it will handle routing internally
      const id = env.WEBSOCKET_BRIDGE.idFromName('websocket-bridge');
      const obj = env.WEBSOCKET_BRIDGE.get(id);
      
      return obj.fetch(request);
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'Multi-Tenant WebSocket Bridge',
        version: '2.0.0',
        endpoints: {
          websocket: {
            url: '/websocket?type=runtime|agent&projectId=PROJECT_ID',
            description: 'WebSocket endpoint with user-specific routing'
          },
          status: {
            url: '/status',
            description: 'Overall connection status and statistics'
          },
          users: {
            url: '/users',
            description: 'User-specific connection information'
          },
          health: {
            url: '/health',
            description: 'Health check endpoint'
          }
        },
        usage: {
          runtime: 'ws://your-worker.workers.dev/websocket?type=runtime&projectId=2',
          agent: 'ws://your-worker.workers.dev/websocket?type=agent&projectId=2'
        }
      }, null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response('Not found', { 
      status: 404,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  },
} satisfies ExportedHandler<Env>;