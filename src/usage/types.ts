// Usage tracking types

export interface UsageStats {
    projectId: string;
    totalRequests: number;
    dailyRequests: DailyRequestCount[];  // Last 30 days
}

export interface DailyRequestCount {
    date: string;       // Format: YYYY-MM-DD
    count: number;
}

export interface UsageRecord {
    project_id: string;
    date: string;       // Format: YYYY-MM-DD
    count: number;
}
