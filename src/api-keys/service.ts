import { ApiKey, CreateApiKeyRequest, CreateApiKeyData, ApiKeyInfo, ValidateApiKeyResult } from './types';

/**
 * Generate a secure API key with prefix
 * Format: sa_live_<32 random hex chars>
 */
export function generateApiKey(): string {
    const randomBytes = new Uint8Array(16); // 16 bytes = 32 hex chars
    crypto.getRandomValues(randomBytes);
    const randomHex = Array.from(randomBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `sa_live_${randomHex}`;
}

/**
 * Hash an API key using SHA-256
 */
export async function hashApiKey(apiKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract the prefix from an API key (first 12 chars)
 */
export function getKeyPrefix(apiKey: string): string {
    return apiKey.substring(0, 12); // "sa_live_xxxx"
}

/**
 * Execute a query against Neon PostgreSQL using the HTTP API
 */
async function executeQuery<T>(
    connectionString: string,
    query: string,
    params: any[] = []
): Promise<T[]> {
    // Parse connection string to get host and credentials
    const url = new URL(connectionString);
    const host = url.hostname;
    const database = url.pathname.slice(1);
    const user = url.username;
    const password = url.password;

    // Neon serverless HTTP endpoint
    const httpEndpoint = `https://${host}/sql`;

    const response = await fetch(httpEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Neon-Connection-String': connectionString,
        },
        body: JSON.stringify({
            query,
            params,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Database query failed: ${error}`);
    }

    const result = await response.json() as { rows: T[] };
    return result.rows || [];
}

/**
 * Create a new API key for a project
 */
export async function createApiKey(
    connectionString: string,
    request: CreateApiKeyRequest
): Promise<CreateApiKeyData> {
    const { projectId, description, createdBy } = request;

    // Check if project already has an active key
    const existing = await executeQuery<ApiKey>(
        connectionString,
        'SELECT * FROM api_keys WHERE project_id = $1 AND is_active = true',
        [projectId]
    );

    if (existing.length > 0) {
        throw new Error(`Project ${projectId} already has an active API key. Revoke it first to create a new one.`);
    }

    // Generate new key
    const apiKey = generateApiKey();
    const keyHash = await hashApiKey(apiKey);
    const keyPrefix = getKeyPrefix(apiKey);

    // Insert into database
    await executeQuery(
        connectionString,
        `INSERT INTO api_keys (project_id, key_hash, key_prefix, created_by, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, keyHash, keyPrefix, createdBy || null, description || null]
    );

    return {
        projectId,
        apiKey,  // Return full key only once!
        keyPrefix,
        createdAt: new Date().toISOString(),
    };
}

/**
 * Validate an API key for a project
 */
export async function validateApiKey(
    connectionString: string,
    projectId: string,
    apiKey: string
): Promise<ValidateApiKeyResult> {
    if (!apiKey || !projectId) {
        return { valid: false, error: 'Missing projectId or apiKey' };
    }

    // Basic format validation
    if (!apiKey.startsWith('sa_live_') && !apiKey.startsWith('sa_test_')) {
        return { valid: false, error: 'Invalid API key format' };
    }

    try {
        const keyHash = await hashApiKey(apiKey);

        const results = await executeQuery<ApiKey>(
            connectionString,
            `SELECT * FROM api_keys
             WHERE project_id = $1 AND key_hash = $2 AND is_active = true`,
            [projectId, keyHash]
        );

        if (results.length === 0) {
            return { valid: false, error: 'Invalid API key for this project' };
        }

        // Update last_used_at (fire and forget)
        executeQuery(
            connectionString,
            'UPDATE api_keys SET last_used_at = NOW() WHERE project_id = $1 AND key_hash = $2',
            [projectId, keyHash]
        ).catch(err => console.error('Failed to update last_used_at:', err));

        return { valid: true, projectId };
    } catch (error: any) {
        console.error('API key validation error:', error);
        return { valid: false, error: 'Validation failed' };
    }
}

/**
 * Get API key info (without the actual key)
 */
export async function getApiKeyInfo(
    connectionString: string,
    projectId: string
): Promise<ApiKeyInfo | null> {
    const results = await executeQuery<ApiKey>(
        connectionString,
        'SELECT * FROM api_keys WHERE project_id = $1 AND is_active = true',
        [projectId]
    );

    if (results.length === 0) {
        return null;
    }

    const key = results[0];
    return {
        projectId: key.project_id,
        keyPrefix: key.key_prefix,
        createdAt: key.created_at.toString(),
        lastUsedAt: key.last_used_at?.toString() || null,
        isActive: key.is_active,
        description: key.description,
    };
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(
    connectionString: string,
    projectId: string
): Promise<boolean> {
    const results = await executeQuery<{ id: number }>(
        connectionString,
        'UPDATE api_keys SET is_active = false WHERE project_id = $1 AND is_active = true RETURNING id',
        [projectId]
    );

    return results.length > 0;
}

/**
 * List all API keys (for admin purposes)
 */
export async function listApiKeys(
    connectionString: string
): Promise<ApiKeyInfo[]> {
    const results = await executeQuery<ApiKey>(
        connectionString,
        'SELECT * FROM api_keys WHERE is_active = true ORDER BY created_at DESC'
    );

    return results.map(key => ({
        projectId: key.project_id,
        keyPrefix: key.key_prefix,
        createdAt: key.created_at.toString(),
        lastUsedAt: key.last_used_at?.toString() || null,
        isActive: key.is_active,
        description: key.description,
    }));
}
