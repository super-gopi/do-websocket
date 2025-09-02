export interface Env {
  WEBSOCKET_BRIDGE: DurableObjectNamespace;
}

export type ClientType = 'runtime' | 'agent';

export interface Connection {
  id: string;
  type: ClientType;
  socket: WebSocket;
  connectedAt: number;
  projectId?: string;  // NEW: Track which user this connection belongs to
  metadata?: Record<string, any>; // NEW: Store additional connection info
}

export interface BaseMessage {
  type: string;
  timestamp: number;
  requestId?: string;
  projectId?: string;  // NEW: Include user ID in all messages
}

export interface ConnectedMessage extends BaseMessage {
  type: 'connected';
  clientId: string;
  clientType: ClientType;
  projectId?: string;
  message: string;
}

export interface GraphQLQueryMessage extends BaseMessage {
  type: 'graphql_query';
  query: string;
  variables?: Record<string, any>;
  requestId: string;
  projectId: string;  // REQUIRED: Must specify which user's data to query
  runtimeId?: string;
}

export interface QueryResponseMessage extends BaseMessage {
  type: 'query_response';
  requestId: string;
  projectId: string;
  data?: any;
  error?: string;
  runtimeId?: string;
}

export interface GetDocsMessage extends BaseMessage {
  type: 'get_docs';
  requestId: string;
  projectId: string;
  error?: string;
}

export interface DocsMessage extends BaseMessage {
  type: 'docs';
  requestId: string;
  projectId: string;
  data?: any;
  error?: string;
} 

export interface UserConnectionMessage extends BaseMessage {
  type: 'user_connection';
  action: 'connect' | 'disconnect';
  projectId: string;
  clientType: ClientType;
}

export interface PingMessage extends BaseMessage {
  type: 'ping';
}

export interface PongMessage extends BaseMessage {
  type: 'pong';
}

export interface ErrorMessage extends BaseMessage {
  type: 'error';
  message: string;
  error?: string;
  requestId?: string;
  projectId?: string;
}

export type WebSocketMessage = 
  | ConnectedMessage 
  | GraphQLQueryMessage 
  | QueryResponseMessage 
  | UserConnectionMessage
  | PingMessage 
  | PongMessage 
  | ErrorMessage
  | DocsMessage
  | GetDocsMessage;

export interface UserConnections {
  projectId: string;
  runtime?: Connection;
  agents: Connection[];  // Multiple agents possible per user
  lastActivity: number;
}

export interface ConnectionStatus {
  activeConnections: number;
  totalUsers: number;
  userConnections: Record<string, {
    projectId: string;
    hasRuntime: boolean;
    agentCount: number;
    lastActivity: number;
  }>;
  connections: Array<{
    id: string;
    type: ClientType;
    projectId?: string;
    connectedAt: number;
    connectedFor: number;
  }>;
  timestamp: number;
}
