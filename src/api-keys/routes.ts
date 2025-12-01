import {
    createApiKey,
    getApiKeyInfo,
    revokeApiKey,
    listApiKeys,
} from './service';
import { CreateApiKeyRequest, ApiResponse, CreateApiKeyData, ApiKeyInfo } from './types';

interface ApiKeyEnv {
    DATABASE_URL: string;
    SUPERATOM_SERVICE_KEY: string;
}

/**
 * Helper to create a JSON response with ApiResponse format
 */
function jsonResponse<T>(response: ApiResponse<T>, status: number = 200): Response {
    return new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Validate the service key for admin operations
 */
function validateServiceKey(request: Request, env: ApiKeyEnv): ApiResponse | null {
    const authHeader = request.headers.get('Authorization');
    const serviceKey = authHeader?.replace('Bearer ', '');

    if (!serviceKey || serviceKey !== env.SUPERATOM_SERVICE_KEY) {
        return {
            success: false,
            errors: ['Invalid or missing service key. Use Authorization: Bearer <service-key>'],
        };
    }
    return null; // Valid
}

/**
 * Handle API key routes
 * POST /api-keys - Create a new API key
 * GET /api-keys - List all API keys
 * GET /api-keys/:projectId - Get API key info for a project
 * DELETE /api-keys/:projectId - Revoke an API key
 */
export async function handleApiKeyRoutes(
    request: Request,
    env: ApiKeyEnv
): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if this is an API key route
    if (!path.startsWith('/api-keys')) {
        return null; // Not an API key route
    }

    // Validate service key for all API key operations
    // const authError = validateServiceKey(request, env);
    // if (authError) {
    //     return jsonResponse(authError, 401);
    // }

    // Check if DATABASE_URL is configured
    if (!env.DATABASE_URL) {
        return jsonResponse({
            success: false,
            errors: ['DATABASE_URL is not configured'],
        }, 500);
    }

    try {
        // POST /api-keys - Create new API key
        if (request.method === 'POST' && path === '/api-keys') {
            const body = await request.json() as CreateApiKeyRequest;

            if (!body.projectId) {
                return jsonResponse({
                    success: false,
                    errors: ['projectId is required'],
                }, 400);
            }

            const result = await createApiKey(env.DATABASE_URL, body);
            return jsonResponse<CreateApiKeyData>({
                success: true,
                data: result,
            }, 201);
        }

        // GET /api-keys - List all API keys
        if (request.method === 'GET' && path === '/api-keys') {
            const keys = await listApiKeys(env.DATABASE_URL);
            return jsonResponse<{ keys: ApiKeyInfo[] }>({
                success: true,
                data: { keys },
            });
        }

        // Extract projectId from path for single-project operations
        const projectIdMatch = path.match(/^\/api-keys\/(.+)$/);
        if (projectIdMatch) {
            const projectId = decodeURIComponent(projectIdMatch[1]);

            // GET /api-keys/:projectId - Get API key info
            if (request.method === 'GET') {
                const keyInfo = await getApiKeyInfo(env.DATABASE_URL, projectId);
                if (!keyInfo) {
                    return jsonResponse({
                        success: false,
                        errors: [`No active API key found for project: ${projectId}`],
                    }, 404);
                }
                return jsonResponse<ApiKeyInfo>({
                    success: true,
                    data: keyInfo,
                });
            }

            // DELETE /api-keys/:projectId - Revoke API key
            if (request.method === 'DELETE') {
                const revoked = await revokeApiKey(env.DATABASE_URL, projectId);
                if (!revoked) {
                    return jsonResponse({
                        success: false,
                        errors: [`No active API key found for project: ${projectId}`],
                    }, 404);
                }
                return jsonResponse<{ message: string }>({
                    success: true,
                    data: { message: `API key revoked for project: ${projectId}` },
                });
            }
        }

        // Method not allowed
        return jsonResponse({
            success: false,
            errors: ['Method not allowed. Allowed methods: GET, POST, DELETE'],
        }, 405);

    } catch (error: any) {
        console.error('API key route error:', error);
        return jsonResponse({
            success: false,
            errors: [error.message || 'Internal server error'],
        }, 500);
    }
}
