import { UserWebSocketBridge } from './websocket-bridge';
import { Env } from './types';

// Export the Durable Object class
export { UserWebSocketBridge };

// Main Worker - Routes requests to user-specific Durable Objects
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Extract projectId from URL parameters
		const projectId = url.searchParams.get('projectId');

		if (!projectId) {
			return new Response(JSON.stringify({
				error: 'Missing projectId parameter',
				message: 'Please provide ?projectId=your-project-id in the URL'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Create a Durable Object ID based on the projectId
		// This ensures the same projectId always routes to the same DO instance
		const durableObjectId = env.USER_WEBSOCKET_BRIDGE.idFromName(projectId);
		const durableObjectStub = env.USER_WEBSOCKET_BRIDGE.get(durableObjectId);

		// Forward the request to the user-specific Durable Object
		return durableObjectStub.fetch(request);
	}
};