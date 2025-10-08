export { Broadcaster } from './broadcaster/broadcaster';

export interface Env {
	BROADCASTER: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		console.log('Request URL:', url.toString());


		// Health check endpoint
		if (url.pathname === '/health' && !url.searchParams.get('projectId') && !url.searchParams.get('userId')) {
			return new Response(JSON.stringify({
				status: 'healthy',
				worker: 'main',
				timestamp: Date.now(),
				version: '1.0.0'
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}


		const projectId = url.searchParams.get('projectId');
		if (!projectId) {
			return new Response(
				JSON.stringify({
					error: 'Missing projectId ',
					message: 'Please provide ?projectId=your-project-id',
					receivedUrl: url.toString(),
					examples: [
						`${url.origin}/websocket?projectId=your-project&type=runtime`,
					]
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		try {
			const durableObjectId = env.BROADCASTER.idFromName(projectId);
			const durableObjectStub = env.BROADCASTER.get(durableObjectId);
			const response = await durableObjectStub.fetch(request);

			if (response.status === 101) {
				return response;
			}


			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});

		} catch (error: any) {
			return new Response(
				JSON.stringify({
					error: 'Failed to route to Broadcaster',
					projectId,
					details: error.message,
					timestamp: Date.now()
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}
	},
};

