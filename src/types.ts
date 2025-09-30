// Environment bindings
export interface Env {
	USER_WEBSOCKET: DurableObjectNamespace;
}

// Client types
export type ClientType = 'runtime' | 'agent' | 'prod' | 'admin';

// Connection interface
export interface Connection {
	id: string;
	type: ClientType;
	socket: WebSocket;
	connectedAt: number;
	projectId: string;
	metadata: {
		userAgent: string | null;
		origin: string | null;
	};
}

// Base WebSocket message interface
export interface WebSocketMessage {
	type: string;
	clientId?: string;
	clientType?: ClientType;
	projectId?: string;
	message?: string;
	requestId?: string;
	timestamp: number;
}

// GraphQL Query Message
export interface GraphQLQueryMessage extends WebSocketMessage {
	type: 'graphql_query';
	query: string;
	variables?: Record<string, any>;
	requestId: string;
	projectId: string;
}

export interface GetProdUIMessage extends WebSocketMessage {
	type: 'get_prod_ui';
	projectId: string;
	uiId: string;
	requestId: string;
	prodId?: string;
}

export interface ProdUIResponse extends WebSocketMessage {
	type: 'prod_ui_response';
	requestId: string;
	uiId: string;
	projectId: string;
	data?:any
	error?: string;
	prodId?: string;
}

export interface CheckAgentsMessage extends WebSocketMessage {
	type: 'check_agents';
	requestId: string;
	projectId: string;
}

export interface AgentStatusResponse extends WebSocketMessage {
	type: 'agent_status_response';
	agents:any;
	timestamp: number;
}

// Query Response Message
export interface QueryResponseMessage extends WebSocketMessage {
	type: 'query_response';
	data: any;
	error?: string;
	requestId: string;
	projectId: string;
}

// Get Docs Message
export interface GetDocsMessage extends WebSocketMessage {
	type: 'get_docs';
	requestId: string;
	projectId: string;
	runtimeId?: string; // Added for routing back to runtime
}

// Docs Response Message
export interface DocsMessage extends WebSocketMessage {
	type: 'docs';
	data: any;
	requestId: string;
	projectId: string;
	runtimeId?: string; // Added for routing back to runtime
}

// Ping/Pong Messages
export interface PingMessage extends WebSocketMessage {
	type: 'ping';
}

export interface PongMessage extends WebSocketMessage {
	type: 'pong';
}

// Error Message
export interface ErrorMessage extends WebSocketMessage {
	type: 'error';
	message: string;
	requestId?: string;
	projectId?: string;
}

// Connected Message
export interface ConnectedMessage extends WebSocketMessage {
	type: 'connected';
	clientId: string;
	clientType: ClientType;
	projectId: string;
	message: string;
}

// Status interfaces (for debugging/monitoring)
export interface ConnectionStatus {
	activeConnections: number;
	totalUsers: number;
	userConnections: Record<string, any>;
	connections: Array<{
		id: string;
		type: ClientType;
		projectId: string;
		connectedAt: number;
		connectedFor: number;
	}>;
	timestamp: number;
}

// User connections (legacy - not needed in new architecture but keeping for reference)
export interface UserConnections {
	projectId: string;
	runtime?: Connection;
	agents: Connection[];
	lastActivity: number;
}

 
export interface PendingRequest {
	requestId: string;
	runtimeId: string;
	timestamp: number;
	timeoutId?: number;
}

// Log storage interfaces
export interface StoredLog {
	id: string;
	timestamp: number;
	messageType: string;
	direction: 'incoming' | 'outgoing';
	data: any;
	clientId?: string;
	clientType?: ClientType;
	projectId: string;
	fromClientId?: string; // Original sender for forwarded messages
}

export interface LogBucket {
	hourKey: string; // Format: "2024-01-15-14" (year-month-day-hour)
	logs: StoredLog[];
	createdAt: number;
}