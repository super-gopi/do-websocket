export { Broadcaster } from './broadcaster/broadcaster';
import { handleApiKeyRoutes, validateApiKey } from './api-keys';

export interface Env {
	BROADCASTER: DurableObjectNamespace;
	DATABASE_URL: string;
	SUPERATOM_SERVICE_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

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

		// Handle API key management routes (POST/GET/DELETE /api-keys)
		const apiKeyResponse = await handleApiKeyRoutes(request, env);
		if (apiKeyResponse) {
			return apiKeyResponse;
		}

		const projectId = url.searchParams.get('projectId');
		if (!projectId) {
			return new Response(
				JSON.stringify({
					error: 'Missing projectId ',
					message: 'Please provide ?projectId=your-project-id',
					receivedUrl: url.toString(),
					examples: [
						`${url.origin}/websocket?projectId=your-project&type=runtime&apiKey=sa_live_xxx`,
					]
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Validate API key only if provided (optional validation)
		// API key can be passed via query param or header
		const apiKey = url.searchParams.get('apiKey') || request.headers.get('x-api-key');

		// Skip API key validation for demo projects
		const skipValidationProjects = ['demo', 'demo-prod'];
		const shouldSkipValidation = skipValidationProjects.includes(projectId);

		if (apiKey && !shouldSkipValidation) {
			// Validate the API key against the database
			if (!env.DATABASE_URL) {
				return new Response(
					JSON.stringify({
						error: 'Server configuration error',
						message: 'DATABASE_URL is not configured',
					}),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}

			const validationResult = await validateApiKey(env.DATABASE_URL, projectId, apiKey);
			if (!validationResult.valid) {
				return new Response(
					JSON.stringify({
						error: 'Invalid API key',
						message: validationResult.error || 'API key validation failed',
						projectId,
					}),
					{
						status: 403,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
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

