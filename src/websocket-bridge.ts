import {
	Connection,
	ClientType,
	WebSocketMessage,
	Env,
	DocsMessage,
	GetDocsMessage
} from './types';

export class UserWebSocketBridge implements DurableObject {
	private runtime: Connection | null = null;
	private agents: Map<string, Connection> = new Map();
	private projectId: string;
	private lastActivity: number;

	constructor(
		private state: DurableObjectState,
		private env: Env
	) {
		this.lastActivity = Date.now();
		// Extract projectId from the Durable Object name
		this.projectId = this.state.id.name!;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/websocket') {
			return this.handleWebSocketUpgrade(request);
		}

		if (url.pathname === '/status') {
			return this.getStatus();
		}

		if (url.pathname === '/health') {
			return new Response(JSON.stringify({
				status: 'healthy',
				projectId: this.projectId,
				timestamp: Date.now(),
				hasRuntime: !!this.runtime,
				agentCount: this.agents.size,
				lastActivity: this.lastActivity
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
		const requestProjectId = url.searchParams.get('projectId');

		// Validate required parameters
		if (!clientType || !['runtime', 'agent'].includes(clientType)) {
			server.close(1008, 'Invalid client type. Use ?type=runtime or ?type=agent');
			return new Response('Invalid client type', { status: 400 });
		}

		// Ensure projectId matches this Durable Object's projectId
		if (requestProjectId !== this.projectId) {
			server.close(1008, 'Project ID mismatch');
			return new Response('Project ID mismatch', { status: 400 });
		}

		const clientId = crypto.randomUUID();

		// Store connection
		const connection: Connection = {
			id: clientId,
			type: clientType,
			socket: server,
			connectedAt: Date.now(),
			projectId: this.projectId,
			metadata: {
				userAgent: request.headers.get('User-Agent'),
				origin: request.headers.get('Origin')
			}
		};

		// Store connection based on type
		if (clientType === 'runtime') {
			// Close existing runtime connection if any
			if (this.runtime) {
				this.runtime.socket.close(1000, 'New runtime connection');
			}
			this.runtime = connection;
		} else if (clientType === 'agent') {
			this.agents.set(clientId, connection);
		}

		this.lastActivity = Date.now();

		console.log(`${clientType} connected for project ${this.projectId} with ID: ${clientId}`);

		// Set up event listeners
		server.addEventListener('message', (event: MessageEvent) => {
			this.handleMessage(clientId, event.data as string);
		});

		server.addEventListener('close', () => {
			this.handleDisconnection(clientId, clientType);
		});

		server.addEventListener('error', (event: Event) => {
			console.error(`WebSocket error for ${clientType} (${clientId}):`, event.type);
			this.handleDisconnection(clientId, clientType);
		});

		// Send welcome message
		const welcomeMessage: WebSocketMessage = {
			type: 'connected',
			clientId: clientId,
			clientType: clientType,
			projectId: this.projectId,
			message: `Connected as ${clientType} for project ${this.projectId}`,
			timestamp: Date.now()
		};

		server.send(JSON.stringify(welcomeMessage));

		return new Response(null, {
			status: 101,
			webSocket: client
		});
	}

	private handleDisconnection(clientId: string, clientType: ClientType): void {
		console.log(`${clientType} (${clientId}) for project ${this.projectId} disconnected`);

		if (clientType === 'runtime') {
			this.runtime = null;
		} else if (clientType === 'agent') {
			this.agents.delete(clientId);
		}

		this.lastActivity = Date.now();

		// Optional: Set an alarm to clean up this DO if inactive
		this.scheduleCleanupIfEmpty();
	}

	private async scheduleCleanupIfEmpty(): Promise<void> {
		// If no connections left, schedule cleanup after 5 minutes
		if (!this.runtime && this.agents.size === 0) {
			const cleanupTime = Date.now() + 5 * 60 * 1000; // 5 minutes
			await this.state.storage.setAlarm(cleanupTime);
		} else {
			// Cancel any existing alarm if we have active connections
			await this.state.storage.deleteAlarm();
		}
	}

	async alarm(): Promise<void> {
		// Clean up if still empty after alarm fires
		if (!this.runtime && this.agents.size === 0) {
			console.log(`Cleaning up empty Durable Object for project ${this.projectId}`);
			// The DO will naturally be garbage collected after this
		}
	}

	private async handleMessage(senderId: string, message: string): Promise<void> {
		try {
			const data: WebSocketMessage = JSON.parse(message);
			this.lastActivity = Date.now();

			console.log(`Message from ${data.type || 'unknown'} (${senderId}) for project ${this.projectId}:`, data.type);

			switch (data.type) {
				case 'graphql_query':
					await this.forwardToDataAgent(senderId, data);
					break;

				case 'get_docs':
					await this.forwardGetDocsToAgent(senderId, data);
					break;

				case 'docs':
					await this.forwardDocsToRuntime(senderId, data);
					break;

				case 'query_response':
					await this.forwardToRuntime(senderId, data);
					break;

				case 'ping':
					this.handlePing(senderId);
					break;

				default:
					console.warn(`Unknown message type: ${data.type}`);
					this.sendError(senderId, `Unknown message type: ${data.type}`);
			}

		} catch (error) {
			console.error(`Error handling message from ${senderId}:`, error);
			this.sendError(senderId, 'Failed to process message');
		}
	}

	private async forwardToDataAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'graphql_query') return;

		const queryMessage = data as any; // GraphQLQueryMessage

		// Get any available agent (or implement load balancing)
		const agent = this.getAvailableAgent();

		if (!agent) {
			console.log(`No data agent for project ${this.projectId}, using dummy data`);

			const dummyData = this.generateDummyData(queryMessage.query, this.projectId);

			const dummyResponse: WebSocketMessage = {
				type: 'query_response',
				requestId: queryMessage.requestId,
				projectId: this.projectId,
				data: dummyData,
				timestamp: Date.now()
			} as any;

			if (this.runtime) {
				try {
					this.runtime.socket.send(JSON.stringify(dummyResponse));
					console.log(`Sent dummy data response to runtime for project ${this.projectId}`);
				} catch (error) {
					console.error(`Failed to send dummy response to runtime:`, error);
				}
			}
			return;
		}

		// Forward to agent
		const forwardMessage = {
			...queryMessage,
			runtimeId: runtimeId
		};

		try {
			agent.socket.send(JSON.stringify(forwardMessage));
			console.log(`Forwarded GraphQL query to agent ${agent.id} for project ${this.projectId}`);
		} catch (error) {
			console.error(`Failed to forward message to data agent:`, error);
			this.sendError(runtimeId, `Failed to forward message to data agent`, queryMessage.requestId);
		}
	}

	private async forwardGetDocsToAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'get_docs') return;

		const docsRequest = data as GetDocsMessage;
		const agent = this.getAvailableAgent();

		if (!agent) {
			console.log(`No data agent for project ${this.projectId}, returning dummy docs`);

			const dummyDocs = this.generateDummyDocs(this.projectId);

			const dummyResponse: DocsMessage = {
				type: 'docs',
				requestId: docsRequest.requestId,
				projectId: this.projectId,
				data: dummyDocs,
				timestamp: Date.now()
			};

			if (this.runtime) {
				try {
					this.runtime.socket.send(JSON.stringify(dummyResponse));
					console.log(`Sent dummy docs response to runtime for project ${this.projectId}`);
				} catch (error) {
					console.error(`Failed to send dummy docs response:`, error);
				}
			}
			return;
		}

		// Forward docs request to agent
		const forwardMessage: GetDocsMessage = {
			...docsRequest,
			runtimeId: runtimeId
		} as any;

		try {
			agent.socket.send(JSON.stringify(forwardMessage));
			console.log(`Forwarded docs request to agent ${agent.id} for project ${this.projectId}`);
		} catch (error) {
			console.error(`Failed to forward docs request to agent:`, error);
			this.sendError(runtimeId, `Failed to forward docs request`, docsRequest.requestId);
		}
	}

	private async forwardDocsToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'docs' || !this.runtime) return;

		const response = data as DocsMessage;

		try {
			this.runtime.socket.send(JSON.stringify(response));
			console.log(`Forwarded docs response from agent ${agentId} to runtime for project ${this.projectId}`);
		} catch (error) {
			console.error(`Failed to forward docs response to runtime:`, error);
		}
	}

	private async forwardToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'query_response' || !this.runtime) return;

		const response = data as any; // QueryResponseMessage

		try {
			this.runtime.socket.send(JSON.stringify(response));
			console.log(`Forwarded query response from agent ${agentId} to runtime for project ${this.projectId}`);
		} catch (error) {
			console.error(`Failed to forward response to runtime:`, error);
		}
	}

	private getAvailableAgent(): Connection | null {
		if (this.agents.size === 0) return null;

		// Return the first agent (or implement load balancing later)
		return Array.from(this.agents.values())[0];
	}

	private handlePing(senderId: string): void {
		const connection = this.findConnection(senderId);
		if (!connection) return;

		const pongMessage: WebSocketMessage = {
			type: 'pong',
			timestamp: Date.now()
		};

		try {
			connection.socket.send(JSON.stringify(pongMessage));
		} catch (error) {
			console.error(`Failed to send pong to ${senderId}:`, error);
		}
	}

	private findConnection(clientId: string): Connection | null {
		if (this.runtime?.id === clientId) return this.runtime;
		return this.agents.get(clientId) || null;
	}

	private sendError(clientId: string, message: string, requestId?: string): void {
		const connection = this.findConnection(clientId);
		if (!connection) return;

		const errorMessage: WebSocketMessage = {
			type: 'error',
			message,
			requestId,
			projectId: this.projectId,
			timestamp: Date.now()
		};

		try {
			connection.socket.send(JSON.stringify(errorMessage));
		} catch (error) {
			console.error(`Failed to send error message to ${clientId}:`, error);
		}
	}

	private async getStatus(): Promise<Response> {
		const status = {
			projectId: this.projectId,
			hasRuntime: !!this.runtime,
			agentCount: this.agents.size,
			lastActivity: this.lastActivity,
			connections: {
				runtime: this.runtime ? {
					id: this.runtime.id,
					connectedAt: this.runtime.connectedAt,
					connectedFor: Date.now() - this.runtime.connectedAt
				} : null,
				agents: Array.from(this.agents.values()).map(agent => ({
					id: agent.id,
					connectedAt: agent.connectedAt,
					connectedFor: Date.now() - agent.connectedAt
				}))
			},
			timestamp: Date.now()
		};

		return new Response(JSON.stringify(status, null, 2), {
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*'
			}
		});
	}

	private generateDummyData(query: string, projectId: string): any {
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
						author: { id: projectId, name: "Current User" },
						createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
						published: false,
						tags: ["graphql", "api", "best-practices"]
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
						id: projectId,
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

		// Default fallback
		return {
			message: "Dummy data response",
			query: query,
			projectId: projectId,
			timestamp: new Date().toISOString(),
			note: "This is test data - no data agent connected"
		};
	}

	private generateDummyDocs(projectId: string): any {
		return {
			databaseName: `project_${projectId}_database`,
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
						comments: { type: 'one-to-many', table: 'comments', foreignKey: 'author_id' }
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
						created_at: { type: 'TIMESTAMP', required: true, description: 'Post creation time' }
					},
					relationships: {
						author: { type: 'belongs-to', table: 'users', foreignKey: 'author_id' },
						comments: { type: 'one-to-many', table: 'comments', foreignKey: 'post_id' }
					}
				}
			},
			metadata: {
				lastUpdated: new Date().toISOString(),
				totalTables: 2,
				totalColumns: 11,
				fetchedAt: new Date().toISOString()
			}
		};
	}
}