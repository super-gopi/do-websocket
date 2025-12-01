export interface ApiKey {
    id: number;
    project_id: string;
    key_hash: string;
    key_prefix: string;
    created_at: Date;
    last_used_at: Date | null;
    is_active: boolean;
    created_by: string | null;
    description: string | null;
}

export interface CreateApiKeyRequest {
    projectId: string;
    description?: string;
    createdBy?: string;
}

export interface CreateApiKeyData {
    projectId: string;
    apiKey: string;          // Full API key (only returned once!)
    keyPrefix: string;       // Prefix for identification
    createdAt: string;
}

export interface ApiKeyInfo {
    projectId: string;
    keyPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    isActive: boolean;
    description: string | null;
}

export interface ValidateApiKeyResult {
    valid: boolean;
    projectId?: string;
    error?: string;
}

// Standard API response type
export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    errors?: string[];
}
