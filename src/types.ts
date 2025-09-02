// Environment bindings
export interface Env {
	USER_WEBSOCKET_BRIDGE: DurableObjectNamespace;
}

// Client types
export type ClientType = 'runtime' | 'agent';

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