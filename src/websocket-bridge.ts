import { Connection, ClientType, WebSocketMessage, Env, ConnectionStatus, UserConnections } from './types';

export class WebSocketBridge implements DurableObject {
  private connections: Map<string, Connection>;
  private userConnections: Map<string, UserConnections>; // NEW: Track connections per user
  
  constructor(
    private state: DurableObjectState, 
    private env: Env
  ) {
    this.connections = new Map();
    this.userConnections = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/websocket') {
      return this.handleWebSocketUpgrade(request);
    }
    
    if (url.pathname === '/status') {
      return this.getStatus();
    }

    if (url.pathname === '/users') {
      return this.getUsersStatus();
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        timestamp: Date.now(),
        activeConnections: this.connections.size,
        activeUsers: this.userConnections.size
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();
    
    const url = new URL(request.url);
    const clientType = url.searchParams.get('type') as ClientType;
    const userId = url.searchParams.get('userId'); // NEW: Get user ID from URL
    const clientId = crypto.randomUUID();
    
    // Validate required parameters
    if (!clientType || !['runtime', 'agent'].includes(clientType)) {
      server.close(1008, 'Invalid client type. Use ?type=runtime or ?type=agent');
      return new Response('Invalid client type', { status: 400 });
    }

    if (!userId) {
      server.close(1008, 'Missing userId parameter. Use ?userId=user123');
      return new Response('Missing userId parameter', { status: 400 });
    }
    
    // Store connection with user association
    const connection: Connection = {
      id: clientId,
      type: clientType,
      socket: server,
      connectedAt: Date.now(),
      userId: userId,
      metadata: {
        userAgent: request.headers.get('User-Agent'),
        origin: request.headers.get('Origin')
      }
    };
    
    this.connections.set(clientId, connection);
    this.updateUserConnections(userId, connection, 'connect');
    
    console.log(`${clientType} connected for user ${userId} with ID: ${clientId}`);
    
    // Set up event listeners
    server.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(clientId, event.data as string);
    });
    
    server.addEventListener('close', () => {
      this.handleDisconnection(clientId);
    });
    
    server.addEventListener('error', (error: ErrorEvent) => {
      console.error(`WebSocket error for ${clientType} (${clientId}):`, error.message);
      this.handleDisconnection(clientId);
    });
    
    // Send welcome message
    const welcomeMessage: WebSocketMessage = {
      type: 'connected',
      clientId: clientId,
      clientType: clientType,
      userId: userId,
      message: `Connected as ${clientType} for user ${userId}`,
      timestamp: Date.now()
    };
    
    server.send(JSON.stringify(welcomeMessage));
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private handleDisconnection(clientId: string): void {
    const connection = this.connections.get(clientId);
    if (!connection) return;
    
    console.log(`${connection.type} (${clientId}) for user ${connection.userId} disconnected`);
    
    // Update user connections
    if (connection.userId) {
      this.updateUserConnections(connection.userId, connection, 'disconnect');
    }
    
    // Remove from main connections map
    this.connections.delete(clientId);
  }

  private updateUserConnections(userId: string, connection: Connection, action: 'connect' | 'disconnect'): void {
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, {
        userId: userId,
        agents: [],
        lastActivity: Date.now()
      });
    }
    
    const userConn = this.userConnections.get(userId)!;
    userConn.lastActivity = Date.now();
    
    if (action === 'connect') {
      if (connection.type === 'runtime') {
        userConn.runtime = connection;
      } else if (connection.type === 'agent') {
        userConn.agents.push(connection);
      }
    } else {
      if (connection.type === 'runtime') {
        userConn.runtime = undefined;
      } else if (connection.type === 'agent') {
        userConn.agents = userConn.agents.filter(agent => agent.id !== connection.id);
      }
      
      // Clean up if no connections left for this user
      if (!userConn.runtime && userConn.agents.length === 0) {
        this.userConnections.delete(userId);
      }
    }
  }

  private async handleMessage(senderId: string, message: string): Promise<void> {
    try {
      const data: WebSocketMessage = JSON.parse(message);
      const sender = this.connections.get(senderId);
      
      if (!sender) {
        console.error(`Sender ${senderId} not found`);
        return;
      }
      
      // Update last activity for user
      if (sender.userId) {
        const userConn = this.userConnections.get(sender.userId);
        if (userConn) {
          userConn.lastActivity = Date.now();
        }
      }
      
      console.log(`Message from ${sender.type} (${senderId}) for user ${sender.userId}:`, data.type);
      
      switch (data.type) {
        case 'graphql_query':
          await this.forwardToUserDataAgent(senderId, data);
          break;
        
        case 'get_docs':
          await this.forwardToUserDataAgent(senderId, data);
          break;
        case 'docs':
          await this.forwardToUserRuntime(senderId, data);
          break;


        case 'query_response':
          await this.forwardToUserRuntime(senderId, data);
          break;
          
        case 'ping':
          this.handlePing(senderId);
          break;
          
        default:
          console.warn(`Unknown message type from ${sender.type}: ${data.type}`);
          this.sendError(senderId, `Unknown message type: ${data.type}`);
      }
      
    } catch (error) {
      console.error(`Error handling message from ${senderId}:`, error);
      this.sendError(senderId, 'Failed to process message');
    }
  }

  private async forwardToUserDataAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
    if (data.type !== 'graphql_query' && data.type !== 'get_docs') return;
    
    const queryMessage = data as any; // GraphQLQueryMessage
    const userId = queryMessage.userId;
    
    if (!userId) {
      this.sendError(runtimeId, 'Missing userId in GraphQL query', queryMessage.requestId);
      return;
    }
    
    // Find data agent for this specific user
    const userDataAgent = this.findUserDataAgent(userId);
    
    if (!userDataAgent) {
    //   this.sendError(
    //     runtimeId, 
    //     `No data agent connected for user ${userId}`, 
    //     queryMessage.requestId
    //   );
    //   return;

     console.log(`No data agent for user ${userId}, returning dummy data for testing`);
      
      // Generate dummy data based on the query
      const dummyData = this.generateDummyData(queryMessage.query, userId);
      
      // Send dummy response back to runtime
      const dummyResponse: WebSocketMessage = {
        type: 'query_response',
        requestId: queryMessage.requestId,
        userId: userId,
        data: dummyData,
        timestamp: Date.now()
      } as any;
      
      const runtime = this.connections.get(runtimeId);
      if (runtime) {
        try {
          runtime.socket.send(JSON.stringify(dummyResponse));
          console.log(`Sent dummy data response to runtime ${runtimeId} for user ${userId}`);
        } catch (error) {
          console.error(`Failed to send dummy response to runtime:`, error);
        }
      }
      
      return;
    }
    
    // Add runtime ID for response routing
    const forwardMessage = {
      ...queryMessage,
      runtimeId: runtimeId
    };
    
    try {
      userDataAgent.socket.send(JSON.stringify(forwardMessage));
      console.log(`Forwarded GraphQL query from runtime ${runtimeId} to agent ${userDataAgent.id} for user ${userId}`);
    } catch (error) {
      console.error(`Failed to forward message to data agent for user ${userId}:`, error);
      this.sendError(runtimeId, `Failed to forward message to data agent for user ${userId}`, queryMessage.requestId);
    }
  }

  private generateDummyData(query: string, userId: string): any {
    const queryLower = query.toLowerCase();
    
    // Posts data
    if (queryLower.includes('posts')) {
      return {
        posts: [
          {
            id: "1",
            title: "Getting Started with Next.js",
            content: "Next.js is a powerful React framework...",
            author: { id: "user1", name: "John Doe" },
            createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
            published: true,
            tags: ["nextjs", "react", "tutorial"]
          },
          {
            id: "2", 
            title: "Understanding WebSockets",
            content: "WebSockets provide real-time communication...",
            author: { id: "user2", name: "Jane Smith" },
            createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            published: true,
            tags: ["websockets", "realtime", "tutorial"]
          },
          {
            id: "3",
            title: "Durable Objects Explained",
            content: "Cloudflare Durable Objects are a new way...",
            author: { id: "user3", name: "Bob Wilson" },
            createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            published: true,
            tags: ["cloudflare", "durable-objects", "serverless"]
          },
          {
            id: "4",
            title: "GraphQL Best Practices",
            content: "GraphQL is a query language for APIs...",
            author: { id: userId, name: "Current User" },
            createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
            published: false,
            tags: ["graphql", "api", "best-practices"]
          },
          {
            id: "5",
            title: "Building Multi-Tenant Applications",
            content: "Multi-tenancy is an architecture pattern...",
            author: { id: "user4", name: "Alice Brown" },
            createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
            published: true,
            tags: ["multi-tenant", "architecture", "saas"]
          }
        ]
      };
    }

    // Users data
    if (queryLower.includes('users')) {
      return {
        users: [
          {
            id: "user1",
            name: "John Doe",
            email: "john@example.com",
            role: "admin",
            createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=face",
            status: "active"
          },
          {
            id: "user2",
            name: "Jane Smith", 
            email: "jane@example.com",
            role: "editor",
            createdAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
            avatar: "https://images.unsplash.com/photo-1494790108755-2616b612e2c0?w=100&h=100&fit=crop&crop=face",
            status: "active"
          },
          {
            id: "user3",
            name: "Bob Wilson",
            email: "bob@example.com", 
            role: "user",
            createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
            avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face",
            status: "inactive"
          },
          {
            id: userId,
            name: "Current User",
            email: "current@example.com",
            role: "user", 
            createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
            avatar: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop&crop=face",
            status: "active"
          }
        ]
      };
    }
    
    // Orders/sales data
    if (queryLower.includes('orders') || queryLower.includes('sales')) {
      return {
        orders: [
          {
            id: "order1",
            userId: userId,
            user: { name: "Current User" },
            total: 149.99,
            status: "completed",
            createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
            items: [
              { id: "item1", name: "Premium Plan", price: 149.99, quantity: 1 }
            ]
          },
          {
            id: "order2", 
            userId: "user2",
            user: { name: "Jane Smith" },
            total: 79.99,
            status: "pending",
            createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            items: [
              { id: "item2", name: "Basic Plan", price: 79.99, quantity: 1 }
            ]
          },
          {
            id: "order3",
            userId: "user1", 
            user: { name: "John Doe" },
            total: 299.99,
            status: "completed",
            createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            items: [
              { id: "item3", name: "Enterprise Plan", price: 299.99, quantity: 1 }
            ]
          }
        ]
      };
    }
    
    // Analytics data
    if (queryLower.includes('analytics') || queryLower.includes('metrics')) {
      return {
        analytics: [
          {
            id: "event1",
            event: "page_view",
            userId: userId,
            metadata: { page: "/dashboard", referrer: "google.com" },
            timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
          },
          {
            id: "event2", 
            event: "button_click",
            userId: userId,
            metadata: { button: "create_post", page: "/editor" },
            timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
          },
          {
            id: "event3",
            event: "page_view", 
            userId: "user2",
            metadata: { page: "/posts", referrer: "direct" },
            timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
          }
        ],
        metrics: {
          totalUsers: 1234,
          totalPosts: 5678,
          totalOrders: 432,
          activeUsers: 89,
          todayViews: 2456
        }
      };
    }
    
    // Default fallback
    return {
      message: "Dummy data response",
      query: query,
      userId: userId,
      timestamp: new Date().toISOString(),
      note: "This is test data - no data agent connected"
    };
}

  private async forwardToUserRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
    if (data.type !== 'query_response' && data.type !== 'docs') return;
    
    const response = data as any; // QueryResponseMessage
    const runtimeId = response.runtimeId;
    const userId = response.userId;
    
    if (!runtimeId) {
      console.error('No runtime ID in query response');
      return;
    }
    
    if (!userId) {
      console.error('No user ID in query response');
      return;
    }
    
    const runtime = this.connections.get(runtimeId);
    if (!runtime) {
      console.error(`Runtime ${runtimeId} not found`);
      return;
    }
    
    // Verify the runtime belongs to the same user
    if (runtime.userId !== userId) {
      console.error(`Runtime user mismatch: expected ${userId}, got ${runtime.userId}`);
      return;
    }
    
    try {
      runtime.socket.send(JSON.stringify(response));
      console.log(`Forwarded query response from agent ${agentId} to runtime ${runtimeId} for user ${userId}`);
    } catch (error) {
      console.error(`Failed to forward response to runtime for user ${userId}:`, error);
    }
  }

  private findUserDataAgent(userId: string): Connection | null {
    const userConn = this.userConnections.get(userId);
    if (!userConn || userConn.agents.length === 0) {
      return null;
    }
    
    // Return the first available agent for this user
    // You could implement load balancing here if user has multiple agents
    return userConn.agents[0];
  }

  private handlePing(senderId: string): void {
    const sender = this.connections.get(senderId);
    if (!sender) return;
    
    const pongMessage: WebSocketMessage = {
      type: 'pong',
      timestamp: Date.now()
    };
    
    try {
      sender.socket.send(JSON.stringify(pongMessage));
    } catch (error) {
      console.error(`Failed to send pong to ${senderId}:`, error);
    }
  }

  private sendError(clientId: string, message: string, requestId?: string): void {
    const client = this.connections.get(clientId);
    if (!client) return;
    
    const errorMessage: WebSocketMessage = {
      type: 'error',
      message,
      requestId,
      userId: client.userId,
      timestamp: Date.now()
    };
    
    try {
      client.socket.send(JSON.stringify(errorMessage));
    } catch (error) {
      console.error(`Failed to send error message to ${clientId}:`, error);
    }
  }

  private async getStatus(): Promise<Response> {
    const connections = Array.from(this.connections.values()).map(conn => ({
      id: conn.id,
      type: conn.type,
      userId: conn.userId,
      connectedAt: conn.connectedAt,
      connectedFor: Date.now() - conn.connectedAt
    }));

    const userConnections: Record<string, any> = {};
    for (const [userId, userConn] of this.userConnections.entries()) {
      userConnections[userId] = {
        userId: userId,
        hasRuntime: !!userConn.runtime,
        agentCount: userConn.agents.length,
        lastActivity: userConn.lastActivity
      };
    }

    const status: ConnectionStatus = {
      activeConnections: this.connections.size,
      totalUsers: this.userConnections.size,
      userConnections,
      connections,
      timestamp: Date.now()
    };

    return new Response(JSON.stringify(status, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  private async getUsersStatus(): Promise<Response> {
    const users = Array.from(this.userConnections.entries()).map(([userId, userConn]) => ({
      userId: userId,
      hasRuntime: !!userConn.runtime,
      agentCount: userConn.agents.length,
      lastActivity: userConn.lastActivity,
      runtimeConnectionId: userConn.runtime?.id,
      agentConnectionIds: userConn.agents.map(agent => agent.id)
    }));

    return new Response(JSON.stringify({
      totalUsers: users.length,
      users: users,
      timestamp: Date.now()
    }, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}