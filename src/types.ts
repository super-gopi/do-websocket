// export interface Env {
//   WEBSOCKET_BRIDGE: DurableObjectNamespace;
// }

// export type ClientType = 'runtime' | 'agent';

// export interface Connection {
//   id: string;
//   type: ClientType;
//   socket: WebSocket;
//   connectedAt: number;
// }

// export interface BaseMessage {
//   type: string;
//   timestamp: number;
//   requestId?: string;
// }

// export interface ConnectedMessage extends BaseMessage {
//   type: 'connected';
//   clientId: string;
//   clientType: ClientType;
//   message: string;
// }

// export interface GraphQLQueryMessage extends BaseMessage {
//   type: 'graphql_query';
//   query: string;
//   variables?: Record<string, any>;
//   requestId: string;
//   runtimeId?: string; // Added by bridge when forwarding to agent
// }

// export interface QueryResponseMessage extends BaseMessage {
//   type: 'query_response';
//   requestId: string;
//   data?: any;
//   error?: string;
//   runtimeId?: string; // Used to route response back to runtime
// }

// export interface PingMessage extends BaseMessage {
//   type: 'ping';
// }

// export interface PongMessage extends BaseMessage {
//   type: 'pong';
// }

// export interface ErrorMessage extends BaseMessage {
//   type: 'error';
//   message: string;
//   error?: string;
//   requestId?: string;
// }

// export type WebSocketMessage = 
//   | ConnectedMessage 
//   | GraphQLQueryMessage 
//   | QueryResponseMessage 
//   | PingMessage 
//   | PongMessage 
//   | ErrorMessage;

// export interface ConnectionStatus {
//   activeConnections: number;
//   connections: Array<{
//     id: string;
//     type: ClientType;
//     connectedAt: number;
//     connectedFor: number;
//   }>;
//   timestamp: number;
// }


export interface Env {
  WEBSOCKET_BRIDGE: DurableObjectNamespace;
}

export type ClientType = 'runtime' | 'agent';

export interface Connection {
  id: string;
  type: ClientType;
  socket: WebSocket;
  connectedAt: number;
  userId?: string;  // NEW: Track which user this connection belongs to
  metadata?: Record<string, any>; // NEW: Store additional connection info
}

export interface BaseMessage {
  type: string;
  timestamp: number;
  requestId?: string;
  userId?: string;  // NEW: Include user ID in all messages
}

export interface ConnectedMessage extends BaseMessage {
  type: 'connected';
  clientId: string;
  clientType: ClientType;
  userId?: string;
  message: string;
}

export interface GraphQLQueryMessage extends BaseMessage {
  type: 'graphql_query';
  query: string;
  variables?: Record<string, any>;
  requestId: string;
  userId: string;  // REQUIRED: Must specify which user's data to query
  runtimeId?: string;
}

export interface QueryResponseMessage extends BaseMessage {
  type: 'query_response';
  requestId: string;
  userId: string;
  data?: any;
  error?: string;
  runtimeId?: string;
}

export interface UserConnectionMessage extends BaseMessage {
  type: 'user_connection';
  action: 'connect' | 'disconnect';
  userId: string;
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
  userId?: string;
}

export type WebSocketMessage = 
  | ConnectedMessage 
  | GraphQLQueryMessage 
  | QueryResponseMessage 
  | UserConnectionMessage
  | PingMessage 
  | PongMessage 
  | ErrorMessage;

export interface UserConnections {
  userId: string;
  runtime?: Connection;
  agents: Connection[];  // Multiple agents possible per user
  lastActivity: number;
}

export interface ConnectionStatus {
  activeConnections: number;
  totalUsers: number;
  userConnections: Record<string, {
    userId: string;
    hasRuntime: boolean;
    agentCount: number;
    lastActivity: number;
  }>;
  connections: Array<{
    id: string;
    type: ClientType;
    userId?: string;
    connectedAt: number;
    connectedFor: number;
  }>;
  timestamp: number;
}
