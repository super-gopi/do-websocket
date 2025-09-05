import {
	Connection,
	ClientType,
	WebSocketMessage,
	Env,
	DocsMessage,
	GetDocsMessage
} from './types';


export class UserWebSocket implements DurableObject {
	private state: DurableObjectState;
  	private env: Env;
	private runtime: Connection | null = null;
	private agents: Map<string, Connection> = new Map();
	private projectId: string;
	private lastActivity: number;

	constructor(state: DurableObjectState,env: Env) {
		this.state = state;
    	this.env = env;

		this.lastActivity = Date.now();

		 // Prefer the "name" if the DO was created with idFromName,
		// otherwise fall back to the deterministic string form
		this.projectId = this.state.id.name ?? this.state.id.toString();

		console.log(`DO Constructor: Initialized for projectId=${this.projectId}`);

	}



	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		console.log(`DO ${this.projectId}: ${request.method} ${url.pathname}${url.search}`);

		// CRITICAL FIX: If projectId is unknown, extract it from the request
		if (this.projectId === 'unknown' || !this.projectId || this.projectId === 'undefined') {
			const urlProjectId = url.searchParams.get('projectId');
			const headerProjectId = request.headers.get('X-Project-Id');

			console.log(`DO: Attempting fallback projectId detection - URL: "${urlProjectId}", Header: "${headerProjectId}"`);

			if (urlProjectId) {
				// console.log(`DO: FIXED - Using projectId from URL: "${urlProjectId}"`);
				this.projectId = urlProjectId;
			} else if (headerProjectId) {
				// console.log(`DO: FIXED - Using projectId from header: "${headerProjectId}"`);
				this.projectId = headerProjectId;
			} else {
				console.error('DO: FAILED - Could not determine projectId from request');
			}
		}

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

		const url = new URL(request.url);
		const upgradeHeader = request.headers.get('Upgrade');

		if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
			console.error(`DO ${this.projectId}: Invalid Upgrade header: ${upgradeHeader}`);
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		const clientType = url.searchParams.get('type') as ClientType;
		const requestProjectId = url.searchParams.get('projectId');

		console.log(`DO ${this.projectId}: Params - type: ${clientType}, projectId: ${requestProjectId}`);

		// Validate client type
		if (!clientType || !['runtime', 'agent'].includes(clientType)) {
			console.error(`DO ${this.projectId}: Invalid client type: ${clientType}`);
			return new Response(JSON.stringify({
				error: 'Invalid client type. Use ?type=runtime or ?type=agent',
				received: clientType,
				valid: ['runtime', 'agent']
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Validate projectId
		if (!requestProjectId) {
			console.error(`DO ${this.projectId}: Missing projectId`);
			return new Response(JSON.stringify({
				error: 'Missing projectId parameter',
				example: '?type=runtime&projectId=your-project-id'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// RELAXED CHECK: Since we have the fallback logic, just ensure we have a projectId
		if (!this.projectId || this.projectId === 'unknown' || this.projectId === 'undefined') {
			console.error(`DO: Still no valid projectId after fallback. Current: "${this.projectId}", Requested: "${requestProjectId}"`);
			return new Response(JSON.stringify({
				error: 'Unable to determine project ID',
				doProjectId: this.projectId,
				requestProjectId: requestProjectId
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}


		try {
			// Create WebSocket pair
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			// Accept the WebSocket connection
			server.accept();

			const clientId = crypto.randomUUID();

			// Create connection object
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
				if (this.runtime) {
					try {
						this.runtime.socket.close(1000, 'New runtime connection');
					} catch (e) {
						console.warn(`DO ${this.projectId}: Error closing old runtime:`, e);
					}
				}
				this.runtime = connection;
			} else if (clientType === 'agent') {
				this.agents.set(clientId, connection);
			}

			this.lastActivity = Date.now();

			// ENHANCED EVENT LISTENERS WITH COMPREHENSIVE LOGGING
			server.addEventListener('message', (event: MessageEvent) => {
				console.log(`DO ${this.projectId}: *** RAW MESSAGE EVENT RECEIVED ***  Event type: ${event.type} From ${clientType} (${clientId})`);

				try {
					this.handleMessage(clientId, event.data as string);
				} catch (error: any) {
					console.error(`DO ${this.projectId}: CRITICAL ERROR in message event handler:`, error);
				}
			});

			server.addEventListener('close', (event) => {
				console.log(`DO ${this.projectId}: ${clientType} (${clientId}) closed: ${event.code} - ${event.reason}`);
				this.handleDisconnection(clientId, clientType);
			});

			server.addEventListener('error', (event: Event) => {
				console.error(`DO ${this.projectId}: WebSocket error for ${clientType} (${clientId}):`, event);
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


			try {
				const messageStr = JSON.stringify(welcomeMessage);
				server.send(messageStr);
			} catch (error: any) {
				console.error(`DO ${this.projectId}: FAILED to send welcome message:`, error);
				return new Response(JSON.stringify({
					error: 'Failed to send welcome message',
					details: error.message
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}


			return new Response(null, {
				status: 101,
				webSocket: client
			});

		} catch (error: any) {
			console.error(`DO ${this.projectId}: WebSocket upgrade error:`, error);
			return new Response(JSON.stringify({
				error: 'WebSocket upgrade failed',
				details: error.message,
				projectId: this.projectId
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	private handleDisconnection(clientId: string, clientType: ClientType): void {
		console.log(`DO ${this.projectId}: *** HANDLING DISCONNECTION *** Client: ${clientType} (${clientId})`);

		if (clientType === 'runtime') {
			this.runtime = null;
		} else if (clientType === 'agent') {
			const wasDeleted = this.agents.delete(clientId);
		}

		this.lastActivity = Date.now();
		this.scheduleCleanupIfEmpty();

	}

	private async scheduleCleanupIfEmpty(): Promise<void> {
		if (!this.runtime && this.agents.size === 0) {
			const cleanupTime = Date.now() + 5 * 60 * 1000;
			await this.state.storage.setAlarm(cleanupTime);
		} else {
			await this.state.storage.deleteAlarm();
		}
	}

	async alarm(): Promise<void> {
		if (!this.runtime && this.agents.size === 0) {
			console.log(`DO ${this.projectId}: Alarm triggered - cleaning up empty DO`);
		}
	}

	private async handleMessage(senderId: string, message: string): Promise<void> {


		console.log('message received in DO', message);

		if (!message || typeof message !== 'string') {
			console.error(`DO ${this.projectId}: Invalid message - not a string or empty`);
			this.sendError(senderId, 'Invalid message format');
			return;
		}

		try {
			console.log(`DO ${this.projectId}: doing parse`);
			const data: WebSocketMessage = JSON.parse(message);

			console.log(`DO ${this.projectId}: Parsed message:`, JSON.stringify(data, null, 2));

			this.lastActivity = Date.now();
			// Log current connection state

			switch (data.type) {
				case 'graphql_query':
					console.log('graphql_query received in DO forward in to data agent', data);
					await this.forwardToDataAgent(senderId, data);
					break;
				case 'get_docs':
					await this.forwardGetDocsToAgent(senderId, data);
					break;
				case 'docs':
					await this.forwardDocsToRuntime(senderId, data);
					break;
				case 'query_response':
					console.log('query_response received in DO forward into runtime', data);
					await this.forwardToRuntime(senderId, data);
					break;
				case 'ping':
					this.handlePing(senderId);
					break;
				case 'error': // 👈 new case
					this.handleErrorMessage(senderId, data);					
					break;
				default:
					this.handleUnknownMessage(senderId, data);					
					// this.sendError(senderId, `Unknown message type: ${data.type}`);
					break;
			}

		} catch (parseError: any) {
			console.error(`DO ${this.projectId}: Parse error message:`, parseError.message, JSON.stringify(message, null, 2));
			this.sendError(senderId, 'Invalid JSON message format');
		}
	}

	private async forwardToDataAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {


		if (data.type !== 'graphql_query') {
			console.error(`DO ${this.projectId}: Message type is not graphql_query (${data.type}), returning`);
			return;
		}

		const queryMessage = data as any;
		

		const agent = this.getAvailableAgent();
		

		if (!agent) {
			console.log(`DO ${this.projectId}: *** NO AGENT AVAILABLE - GENERATING DUMMY DATA ***`);

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
					const responseStr = JSON.stringify(dummyResponse);
					this.runtime.socket.send(responseStr);
					console.log(`DO ${this.projectId}: *** DUMMY DATA SENT SUCCESSFULLY TO RUNTIME ***`);
				} catch (error: any) {
					console.error(`DO ${this.projectId}: Send error details:`, error.message);
				}
			} else {
				console.error(`DO ${this.projectId}: Runtime connection is null - this should not happen!`);
			}
			return;
		}

		const forwardMessage = { ...queryMessage, runtimeId: runtimeId };

		try {
			const forwardStr = JSON.stringify(forwardMessage);
			agent.socket.send(forwardStr);
			console.log(`DO ${this.projectId}: *** MESSAGE FORWARDED SUCCESSFULLY TO AGENT ***`);
		} catch (error: any) {
			console.error(`DO ${this.projectId}: Forward error details:`, error.message);
			this.sendError(runtimeId, `Failed to forward message to data agent`, queryMessage.requestId);
		}
	}

	private async forwardGetDocsToAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: *** ENTERING forwardGetDocsToAgent ***`);

		if (data.type !== 'get_docs') {
			console.error(`DO ${this.projectId}: Message type is not get_docs (${data.type}), returning`);
			return;
		}

		const docsRequest = data as GetDocsMessage;
		const agent = this.getAvailableAgent();


		if (!agent) {
			console.log(`DO ${this.projectId}: *** NO AGENT FOR DOCS - RETURNING DUMMY DOCS ***`);

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
					console.log(`DO ${this.projectId}: *** DUMMY DOCS SENT TO RUNTIME ***`);
				} catch (error) {
					console.error(`DO ${this.projectId}: Failed to send dummy docs:`, error);
				}
			} else {
				console.error(`DO ${this.projectId}: No runtime connection for docs response`);
			}
			return;
		}

		const forwardMessage: GetDocsMessage = { ...docsRequest, runtimeId: runtimeId } as any;
		try {
			agent.socket.send(JSON.stringify(forwardMessage));
			console.log(`DO ${this.projectId}: *** DOCS REQUEST FORWARDED TO AGENT ***`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to forward docs request:`, error);
			this.sendError(runtimeId, `Failed to forward docs request`, docsRequest.requestId);
		}
	}

	private async forwardDocsToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: *** ENTERING forwardDocsToRuntime ***`);

		if (data.type !== 'docs') {
			console.error(`DO ${this.projectId}: Message type is not docs (${data.type}), returning`);
			return;
		}

		if (!this.runtime) {
			console.warn(`DO ${this.projectId}: No runtime connection, ignoring docs from agent ${agentId}`);
			return;
		}

		try {
			this.runtime.socket.send(JSON.stringify(data));
			console.log(`DO ${this.projectId}: *** DOCS FORWARDED TO RUNTIME ***`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to forward docs to runtime:`, error);
		}
	}

	private async forwardToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: *** ENTERING forwardToRuntime ***`);

		if (data.type !== 'query_response') {
			console.error(`DO ${this.projectId}: Message type is not query_response (${data.type}), returning`);
			return;
		}

		if (!this.runtime) {
			console.warn(`DO ${this.projectId}: This query response will be lost: ${(data as any).requestId}`);
			return;
		}

		try {
			const responseStr = JSON.stringify(data);
			this.runtime.socket.send(responseStr);
			console.log(`DO ${this.projectId}: *** QUERY RESPONSE FORWARDED TO RUNTIME SUCCESSFULLY ***`);
		} catch (error: any) {
			console.error(`DO ${this.projectId}: FAILED to forward query response to runtime:`, error);
		}
	}

	private getAvailableAgent(): Connection | null {
		const agentCount = this.agents.size;

		if (agentCount === 0) {
			console.log(`DO ${this.projectId}: No agents available`);
			return null;
		}

		const agents = Array.from(this.agents.values());
		const selectedAgent = agents[0];

		return selectedAgent;
	}

	private handlePing(senderId: string): void {

		const connection = this.findConnection(senderId);
		if (!connection) {
			console.error(`DO ${this.projectId}: No connection found for ping sender: ${senderId}`);
			return;
		}

		try {
			const pongMessage = { type: 'pong', timestamp: Date.now() };
			connection.socket.send(JSON.stringify(pongMessage));
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to send pong:`, error);
		}
	}

	private findConnection(clientId: string): Connection | null {
	
		if (this.runtime?.id === clientId) {
			console.log(`DO ${this.projectId}: Found runtime connection`);
			return this.runtime;
		}

		const agent = this.agents.get(clientId);
		if (agent) {
			console.log(`DO ${this.projectId}: Found agent connection`);
			return agent;
		}

		return null;
	}

	// Centralized error logger — no echoing back
	private handleErrorMessage(senderId: string, data: any): void {
		console.warn(`DO ${this.projectId}: Received error from ${senderId}:`, data);
		// just log & drop — prevents loops
	}

	// Centralized unknown type handler
	private handleUnknownMessage(senderId: string, data: any): void {
		console.warn(`DO ${this.projectId}: Unknown message type "${data?.type}" from ${senderId}`, data);
		// If you want to notify client during dev, uncomment:
		// this.sendError(senderId, `Unknown message type: ${data?.type}`);
	}


	private sendError(clientId: string, message: string, requestId?: string): void {
		console.log(`DO ${this.projectId}: *** SENDING ERROR to ${clientId} ***`);

		// 🔒 Prevent infinite loops: don't send error in response to an error
		if (message.toLowerCase().includes("error")) {
			console.warn(`DO ${this.projectId}: Skipping error send to ${clientId} to avoid loop:`, message);
			return;
		}

		const connection = this.findConnection(clientId);
		if (!connection) {
			console.error(`DO ${this.projectId}: Cannot send error - no connection for client: ${clientId}`);
			return;
		}

		try {
			const errorMessage = {
				type: 'error',
				message,
				requestId,
				projectId: this.projectId,
				timestamp: Date.now()
			};

			connection.socket.send(JSON.stringify(errorMessage));
			console.log(`DO ${this.projectId}: *** ERROR SENT SUCCESSFULLY ***`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to send error message:`, error);
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
			headers: { 'Content-Type': 'application/json' }
		});
	}

	private generateDummyData(query: string, projectId: string): any {

		const queryLower = query.toLowerCase();

		if (queryLower.includes('users') || queryLower.includes('user')) {
			const userData = {
				users: [
					{ id: "1", name: "John Doe", email: "john@example.com", role: "admin", status: "active" },
					{ id: "2", name: "Jane Smith", email: "jane@example.com", role: "user", status: "active" },
					{ id: "3", name: "Bob Wilson", email: "bob@example.com", role: "user", status: "inactive" }
				]
			};

			return userData;
		}

		if (queryLower.includes('posts') || queryLower.includes('post')) {
			const postData = {
				posts: [
					{ id: "1", title: "Getting Started with WebSockets", author: { name: "John Doe" } },
					{ id: "2", title: "Durable Objects Explained", author: { name: "Jane Smith" } },
					{ id: "3", title: "Building Real-time Applications", author: { name: "Bob Wilson" } }
				]
			};

			return postData;
		}

		const defaultData = {
			message: "Dummy data response",
			query,
			projectId,
			timestamp: new Date().toISOString()
		};

		return defaultData;
	}

	private generateDummyDocs(projectId: string): any {

		return {
			databaseName: `project_${projectId}_database`,
			version: '1.0.0',
			tables: {
				users: {
					description: 'User accounts and profiles',
					columns: {
						id: { type: 'UUID', primaryKey: true, description: 'Unique user identifier' },
						name: { type: 'VARCHAR(100)', required: true, description: 'User full name' },
						email: { type: 'VARCHAR(255)', unique: true, description: 'User email address' },
						role: { type: 'VARCHAR(50)', default: 'user', description: 'User role' },
						status: { type: 'VARCHAR(20)', default: 'active', description: 'User status' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Account creation time' }
					}
				},
				posts: {
					description: 'Blog posts and articles',
					columns: {
						id: { type: 'UUID', primaryKey: true, description: 'Unique post identifier' },
						title: { type: 'VARCHAR(200)', required: true, description: 'Post title' },
						content: { type: 'TEXT', description: 'Post content' },
						author_id: { type: 'UUID', required: true, description: 'Reference to author' },
						published: { type: 'BOOLEAN', default: false, description: 'Publication status' },
						created_at: { type: 'TIMESTAMP', required: true, description: 'Creation time' }
					}
				}
			},
			relationships: {
				users_posts: 'users.id -> posts.author_id'
			},
			metadata: {
				totalTables: 2,
				totalColumns: 11,
				generatedAt: new Date().toISOString(),
				note: 'This is dummy documentation for testing purposes'
			}
		};
	}
}