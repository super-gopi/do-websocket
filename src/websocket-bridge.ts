import { Connection, ClientType, WebSocketMessage, Env, ConnectionStatus, UserConnections, DocsMessage, GetDocsMessage } from './types';

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
		const projectId = url.searchParams.get('projectId'); // NEW: Get Project ID from URL
		const clientId = crypto.randomUUID();

		// Validate required parameters
		if (!clientType || !['runtime', 'agent'].includes(clientType)) {
			server.close(1008, 'Invalid client type. Use ?type=runtime or ?type=agent');
			return new Response('Invalid client type', { status: 400 });
		}

		if (!projectId) {
			server.close(1008, 'Missing projectId parameter. Use ?projectId=project123');
			return new Response('Missing projectId parameter', { status: 400 });
		}

		// Store connection with user association
		const connection: Connection = {
			id: clientId,
			type: clientType,
			socket: server,
			connectedAt: Date.now(),
			projectId: projectId,
			metadata: {
				userAgent: request.headers.get('User-Agent'),
				origin: request.headers.get('Origin')
			}
		};

		this.connections.set(clientId, connection);
		this.updateUserConnections(projectId, connection, 'connect');

		console.log(`${clientType} connected for proect ${projectId} with ID: ${clientId}`);

		// Set up event listeners
		server.addEventListener('message', (event: MessageEvent) => {
			this.handleMessage(clientId, event.data as string);
		});

		server.addEventListener('close', () => {
			this.handleDisconnection(clientId);
		});

		server.addEventListener('error', (event: Event) => {
			console.error(`WebSocket error for ${clientType} (${clientId}):`, event.type);
			this.handleDisconnection(clientId);
		});

		// Send welcome message
		const welcomeMessage: WebSocketMessage = {
			type: 'connected',
			clientId: clientId,
			clientType: clientType,
			projectId: projectId,
			message: `Connected as ${clientType} for project ${projectId}`,
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

		console.log(`${connection.type} (${clientId}) for project ${connection.projectId} disconnected`);

		// Update user connections
		if (connection.projectId) {
			this.updateUserConnections(connection.projectId, connection, 'disconnect');
		}

		// Remove from main connections map
		this.connections.delete(clientId);
	}

	private updateUserConnections(projectId: string, connection: Connection, action: 'connect' | 'disconnect'): void {
		if (!this.userConnections.has(projectId)) {
			this.userConnections.set(projectId, {
				projectId: projectId,
				agents: [],
				lastActivity: Date.now()
			});
		}

		const userConn = this.userConnections.get(projectId)!;
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
				this.userConnections.delete(projectId);
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
			if (sender.projectId) {
				const userConn = this.userConnections.get(sender.projectId);
				if (userConn) {
					userConn.lastActivity = Date.now();
				}
			}

			console.log(`Message from ${sender.type} (${senderId}) for project ${sender.projectId}:`, data.type);

			switch (data.type) {
				case 'graphql_query':
					await this.forwardToUserDataAgent(senderId, data);
					break;

				case 'get_docs':  // NEW: Handle docs requests
					await this.forwardGetDocsToAgent(senderId, data);
					break;

				case 'docs': // NEW: Handle docs responses
					await this.forwardDocsToRuntime(senderId, data);
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
		if (data.type !== 'graphql_query') return;

		const queryMessage = data as any; // GraphQLQueryMessage
		const projectId = queryMessage.projectId;

		if (!projectId) {
			this.sendError(runtimeId, 'Missing projectId in GraphQL query', queryMessage.requestId);
			return;
		}

		// Find data agent for this specific user
		const userDataAgent = this.findUserDataAgent(projectId);

		if (!userDataAgent) {
			this.sendError(
				runtimeId,
				`No data agent connected for user ${projectId}`,
				queryMessage.requestId
			);
			return;

			//  console.log(`No data agent for user ${userId}, returning dummy data for testing`);

			//   // Generate dummy data based on the query
			//   const dummyData = this.generateDummyData(queryMessage.query, userId);

			//   // Send dummy response back to runtime
			//   const dummyResponse: WebSocketMessage = {
			//     type: 'query_response',
			//     requestId: queryMessage.requestId,
			//     userId: userId,
			//     data: dummyData,
			//     timestamp: Date.now()
			//   } as any;

			// const runtime = this.connections.get(runtimeId);
			// if (runtime) {
			//   try {
			//     runtime.socket.send(JSON.stringify(dummyResponse));
			//     console.log(`Sent dummy data response to runtime ${runtimeId} for user ${userId}`);
			//   } catch (error) {
			//     console.error(`Failed to send dummy response to runtime:`, error);
			//   }
			// }

			// return;
		}

		// Add runtime ID for response routing
		const forwardMessage = {
			...queryMessage,
			runtimeId: runtimeId
		};

		try {
			userDataAgent.socket.send(JSON.stringify(forwardMessage));
			console.log(`Forwarded GraphQL query from runtime ${runtimeId} to agent ${userDataAgent.id} for project ${projectId}`);
		} catch (error) {
			console.error(`Failed to forward message to data agent for project ${projectId}:`, error);
			this.sendError(runtimeId, `Failed to forward message to data agent for project ${projectId}`, queryMessage.requestId);
		}
	}

	private async forwardGetDocsToAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'get_docs') return;

		const docsRequest = data as GetDocsMessage;
		const projectId = docsRequest.projectId;

		if (!projectId) {
			this.sendError(runtimeId, 'Missing projectId in docs request', docsRequest.requestId);
			return;
		}

		const userDataAgent = this.findUserDataAgent(projectId);

		if (!userDataAgent) {
			// console.log(`No data agent for user ${userId}, returning dummy docs for testing`);

			// // Generate dummy docs data
			// const dummyDocs = this.generateDummyDocs(userId);

			// // Send dummy response back to runtime
			// const dummyResponse: DocsMessage = {
			// 	type: 'docs',
			// 	requestId: docsRequest.requestId,
			// 	userId: userId,
			// 	data: dummyDocs,
			// 	timestamp: Date.now()
			// };

			// const runtime = this.connections.get(runtimeId);
			// if (runtime) {
			// 	try {
			// 		runtime.socket.send(JSON.stringify(dummyResponse));
			// 		console.log(`Sent dummy docs response to runtime ${runtimeId} for user ${userId}`);
			// 	} catch (error) {
			// 		console.error(`Failed to send dummy docs response to runtime:`, error);
			// 	}
			// }
			// return;

			this.sendError(
				runtimeId,
				`No data agent connected for project ${projectId}`,
				docsRequest.requestId
			);
			return;
		}

		// Forward docs request to data agent
		const forwardMessage: GetDocsMessage = {
			...docsRequest,
			runtimeId: runtimeId
		} as any;

		try {
			userDataAgent.socket.send(JSON.stringify(forwardMessage));
			console.log(`Forwarded docs request from runtime ${runtimeId} to agent ${userDataAgent.id} for project ${projectId}`);
		} catch (error) {
			console.error(`Failed to forward docs request to data agent for project ${projectId}:`, error);
			this.sendError(runtimeId, `Failed to forward docs request to data agent for proectId ${projectId}`, docsRequest.requestId);
		}
	}

	private async forwardDocsToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'docs') return;

		const response = data as DocsMessage;
		const runtimeId = (response as any).runtimeId;
		const projectId = response.projectId;	

		if (!runtimeId) {
			console.error('No runtime ID in docs response');
			return;
		}

		if (!projectId) {
			console.error('No project ID in docs response');
			return;
		}

		const runtime = this.connections.get(runtimeId);
		if (!runtime) {
			console.error(`Runtime ${runtimeId} not found`);
			return;
		}

		if (runtime.projectId !== projectId) {
			console.error(`Runtime project mismatch: expected ${projectId}, got ${runtime.projectId}`);
			return;
		}

		try {
			runtime.socket.send(JSON.stringify(response));
			console.log(`Forwarded docs response from agent ${agentId} to runtime ${runtimeId} for project ${projectId}`);
		} catch (error) {
			console.error(`Failed to forward docs response to runtime for project ${projectId}:`, error);
		}
	}

	// NEW: Generate dummy docs data for testing
	private generateDummyDocs(userId?: string): any {
		return {
			databaseName: `user_${userId}_database`,
			version: '1.0.0',
			documentation: 'Database documentation for project',
			tables: {
				users: {
					description: 'User accounts and profiles',
					columns: {
						id: { type: 'UUID', required: true, primaryKey: true, description: 'Unique user identifier' },
						email: { type: 'VARCHAR(255)', required: true, unique: true, description: 'User email address' },
						name: { type: 'VARCHAR(100)', required: true, description: 'User full name' },
						role: { type: 'VARCHAR(50)', required: false, default: 'user', description: 'User role' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Account creation time' },
						updated_at: { type: 'TIMESTAMP', required: true, description: 'Last update time' }
					},
					relationships: {
						posts: { type: 'one-to-many', table: 'posts', foreignKey: 'author_id' },
						comments: { type: 'one-to-many', table: 'comments', foreignKey: 'author_id' },
						orders: { type: 'one-to-many', table: 'orders', foreignKey: 'user_id' }
					}
				},
				posts: {
					description: 'Blog posts and articles',
					columns: {
						id: { type: 'UUID', required: true, primaryKey: true, description: 'Unique post identifier' },
						title: { type: 'VARCHAR(200)', required: true, description: 'Post title' },
						content: { type: 'TEXT', required: false, description: 'Post content body' },
						author_id: { type: 'UUID', required: true, foreignKey: 'users.id', description: 'Reference to post author' },
						published: { type: 'BOOLEAN', required: true, default: false, description: 'Whether post is published' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Post creation time' },
						updated_at: { type: 'TIMESTAMP', required: true, description: 'Last update time' }
					},
					relationships: {
						author: { type: 'belongs-to', table: 'users', foreignKey: 'author_id' },
						comments: { type: 'one-to-many', table: 'comments', foreignKey: 'post_id' }
					}
				},
				comments: {
					description: 'User comments on posts',
					columns: {
						id: { type: 'UUID', required: true, primaryKey: true, description: 'Unique comment identifier' },
						content: { type: 'TEXT', required: true, description: 'Comment text' },
						post_id: { type: 'UUID', required: true, foreignKey: 'posts.id', description: 'Reference to parent post' },
						author_id: { type: 'UUID', required: true, foreignKey: 'users.id', description: 'Reference to comment author' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Comment creation time' }
					},
					relationships: {
						post: { type: 'belongs-to', table: 'posts', foreignKey: 'post_id' },
						author: { type: 'belongs-to', table: 'users', foreignKey: 'author_id' }
					}
				},
				orders: {
					description: 'Customer orders and transactions',
					columns: {
						id: { type: 'UUID', required: true, primaryKey: true, description: 'Unique order identifier' },
						user_id: { type: 'UUID', required: true, foreignKey: 'users.id', description: 'Reference to customer' },
						total: { type: 'DECIMAL(10,2)', required: true, description: 'Order total amount' },
						status: { type: 'VARCHAR(50)', required: true, default: 'pending', description: 'Order status' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Order creation time' }
					},
					relationships: {
						user: { type: 'belongs-to', table: 'users', foreignKey: 'user_id' }
					}
				}
			},
			metadata: {
				lastUpdated: new Date().toISOString(),
				totalTables: 4,
				totalColumns: 23,
				fetchedAt: new Date().toISOString()
			}
		};
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
		if (data.type !== 'query_response') return;

		const response = data as any; // QueryResponseMessage
		const runtimeId = response.runtimeId;
		const projectId = response.projectId;

		if (!runtimeId) {
			console.error('No runtime ID in query response');
			return;
		}

		if (!projectId) {
			console.error('No project ID in query response');
			return;
		}

		const runtime = this.connections.get(runtimeId);
		if (!runtime) {
			console.error(`Runtime ${runtimeId} not found`);
			return;
		}

		// Verify the runtime belongs to the same user
		if (runtime.projectId !== projectId) {
			console.error(`Runtime user mismatch: expected ${projectId}, got ${runtime.projectId}`);
			return;
		}

		try {
			runtime.socket.send(JSON.stringify(response));
			console.log(`Forwarded query response from agent ${agentId} to runtime ${runtimeId} for project ${projectId}`);
		} catch (error) {
			console.error(`Failed to forward response to runtime for project ${projectId}:`, error);
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
			projectId: client.projectId,
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
			projectId: conn.projectId,
			connectedAt: conn.connectedAt,
			connectedFor: Date.now() - conn.connectedAt
		}));

		const userConnections: Record<string, any> = {};
		for (const [projectId, userConn] of this.userConnections.entries()) {
			userConnections[projectId] = {
				projectId: projectId,
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
		const users = Array.from(this.userConnections.entries()).map(([projectId, userConn]) => ({
			projectId: projectId,
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