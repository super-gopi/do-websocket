import {
	Connection,
	ClientType,
	WebSocketMessage,
	Env,
	DocsMessage,
	GetDocsMessage,
	GetProdUIMessage,
	ProdUIResponse
} from './types';

// Add pending requests tracking
interface PendingRequest {
	requestId: string;
	runtimeId: string;
	timestamp: number;
	timeoutId?: number;
}

export class UserWebSocket implements DurableObject {
	private state: DurableObjectState;
  	private env: Env;
	private runtime: Connection | null = null;

	private agents: Map<string, Connection> = new Map();
	private prods: Map<string, Connection> = new Map();
	private admins: Map<string, Connection> = new Map();

	private projectId: string;
	private lastActivity: number;
	
	// Add pending requests tracking
	private pendingRequests: Map<string, PendingRequest> = new Map();
	private readonly REQUEST_TIMEOUT = 30000; // 30 seconds

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
    	this.env = env;
		this.lastActivity = Date.now();
		this.projectId = 'unknown';

		console.log(`DO Constructor: Initialized for projectId=${this.projectId} state=${this.state.id.toString()} state name=${this.state.id.name}`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const urlProjectId = url.searchParams.get('projectId');
		
		if (!urlProjectId) {
			console.error('DO: Missing projectId in request');
			return new Response(JSON.stringify({
				error: 'Missing projectId parameter',
				required: 'Please provide ?projectId=your-project-id'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		
		this.projectId = urlProjectId;
		console.log(`DO ${this.projectId}: ${request.method} ${url.pathname}${url.search}`);

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
				lastActivity: this.lastActivity,
				pendingRequests: this.pendingRequests.size
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
		if (!clientType || !['runtime', 'agent', 'prod','admin'].includes(clientType)) {
			console.error(`DO ${this.projectId}: Invalid client type: ${clientType}`);
			return new Response(JSON.stringify({
				error: 'Invalid client type. Use ?type=runtime, ?type=agent or ?type=prod',
				received: clientType,
				valid: ['runtime', 'agent', 'prod']
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
						// Cancel pending requests for old runtime
						this.cancelPendingRequestsForRuntime(this.runtime.id);
						this.runtime.socket.close(1000, 'New runtime connection');
					} catch (e) {
						console.warn(`DO ${this.projectId}: Error closing old runtime:`, e);
					}
				}
				this.runtime = connection;
			} else if (clientType === 'agent') {
				this.agents.set(clientId, connection);
			} else if (clientType === 'prod') {
				this.prods.set(clientId, connection);
			} else if (clientType === 'admin') {
				this.admins.set(clientId, connection);
				console.log(`DO ${this.projectId}: Admin client ${clientId} connected`);
			}

			this.lastActivity = Date.now();

			// Enhanced event listeners with better error handling
			server.addEventListener('message', (event: MessageEvent) => {
				console.log(`DO ${this.projectId}: Message received from ${clientType} (${clientId})`);

				try {
					this.handleMessage(clientId, event.data as string);
				} catch (error: any) {
					console.error(`DO ${this.projectId}: CRITICAL ERROR in message handler:`, error);
					this.sendError(clientId, 'Internal message processing error');
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

			// Send welcome message with connection info
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
				console.log(`DO ${this.projectId}: Welcome message sent to ${clientType}`);
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
		console.log(`DO ${this.projectId}: Handling disconnection for ${clientType} (${clientId})`);

		if (clientType === 'runtime') {
			this.cancelPendingRequestsForRuntime(clientId);
			this.runtime = null;
		} else if (clientType === 'agent') {
			this.agents.delete(clientId);
			// Cancel any pending requests that were assigned to this agent
			this.cancelPendingRequestsForAgent(clientId);
		} else if (clientType === 'prod') {
			this.prods.delete(clientId);
			console.log(`DO ${this.projectId}: Prod client ${clientId} disconnected`);
		}


		this.lastActivity = Date.now();
		this.scheduleCleanupIfEmpty();
	}

	// Add method to cancel pending requests for disconnected runtime
	private cancelPendingRequestsForRuntime(runtimeId: string): void {
		for (const [requestId, pending] of this.pendingRequests.entries()) {
			if (pending.runtimeId === runtimeId) {
				if (pending.timeoutId) {
					clearTimeout(pending.timeoutId);
				}
				this.pendingRequests.delete(requestId);
				console.log(`DO ${this.projectId}: Cancelled pending request ${requestId} for disconnected runtime`);
			}
		}
	}

	// Add method to cancel pending requests for disconnected agent
	private cancelPendingRequestsForAgent(agentId: string): void {
		// You might want to reassign these to other agents or fail them
		console.log(`DO ${this.projectId}: Agent ${agentId} disconnected with ${this.pendingRequests.size} pending requests`);
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
			// Clear any remaining pending requests
			for (const [requestId, pending] of this.pendingRequests.entries()) {
				if (pending.timeoutId) {
					clearTimeout(pending.timeoutId);
				}
			}
			this.pendingRequests.clear();
		}
	}

	private async handleMessage(senderId: string, message: string): Promise<void> {
		console.log(`DO ${this.projectId}: Processing message from ${senderId}`);

		if (!message || typeof message !== 'string') {
			console.error(`DO ${this.projectId}: Invalid message - not a string or empty`);
			this.sendError(senderId, 'Invalid message format');
			return;
		}



		try {
			const data: WebSocketMessage = JSON.parse(message);
			console.log(`DO ${this.projectId}: Parsed message type: ${data.type}`);

			this.lastActivity = Date.now();

			//sending all the do messages to admins
			this.broadcastToAdmins(senderId, data);

			switch (data.type) {
				case 'graphql_query':
					console.log(`DO ${this.projectId}: GraphQL query received, requestId: ${(data as any).requestId}`);
					await this.forwardToDataAgent(senderId, data);
					break;
				case 'get_docs':
					await this.forwardGetDocsToAgent(senderId, data);
					break;
				case 'docs':
					await this.forwardDocsToRuntime(senderId, data);
					break;
				case 'query_response':
					console.log(`DO ${this.projectId}: Query response received, requestId: ${(data as any).requestId}`);
					await this.forwardToRuntime(senderId, data);
					break;
				case 'get_prod_ui':
					await this.forwardGetProdUIToRuntime(senderId, data as GetProdUIMessage);
					break;
				case 'prod_ui_response':
					await this.forwardProdUIResponseToProd(senderId, data as ProdUIResponse);
					break;
				case 'ping':
					this.handlePing(senderId);
					break;
				case 'error':
					this.handleErrorMessage(senderId, data);					
					break;
				default:
					this.handleUnknownMessage(senderId, data);					
					break;
			}

		} catch (parseError: any) {
			console.error(`DO ${this.projectId}: Parse error:`, parseError.message);
			this.sendError(senderId, 'Invalid JSON message format');
		}
	}

	private async forwardToDataAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		if (data.type !== 'graphql_query') {
			console.error(`DO ${this.projectId}: Message type is not graphql_query (${data.type})`);
			return;
		}

		const queryMessage = data as any;
		const requestId = queryMessage.requestId;

		if (!requestId) {
			console.error(`DO ${this.projectId}: Missing requestId in GraphQL query`);
			this.sendError(runtimeId, 'Missing requestId in query');
			return;
		}

		// Track pending request with timeout
		const timeoutId = setTimeout(() => {
			console.error(`DO ${this.projectId}: Request ${requestId} timed out`);
			this.pendingRequests.delete(requestId);
			this.sendError(runtimeId, `Query timeout after ${this.REQUEST_TIMEOUT}ms`, requestId);
		}, this.REQUEST_TIMEOUT);

		this.pendingRequests.set(requestId, {
			requestId,
			runtimeId,
			timestamp: Date.now(),
			timeoutId
		});

		const agent = this.getAvailableAgent();

		if (!agent) {
			console.log(`DO ${this.projectId}: No agent available for request ${requestId}, using dummy data`);
			
			// Clear timeout since we're handling it immediately
			clearTimeout(timeoutId);
			this.pendingRequests.delete(requestId);

			const dummyData = this.generateDummyData(queryMessage.query, this.projectId);
			const dummyResponse: WebSocketMessage = {
				type: 'query_response',
				requestId: requestId,
				projectId: this.projectId,
				data: dummyData,
				timestamp: Date.now()
			} as any;

			if (this.runtime && this.runtime.id === runtimeId) {
				try {
					const responseStr = JSON.stringify(dummyResponse);
					this.runtime.socket.send(responseStr);
					console.log(`DO ${this.projectId}: Dummy data sent for request ${requestId}`);
				} catch (error: any) {
					console.error(`DO ${this.projectId}: Failed to send dummy response:`, error);
				}
			}
			return;
		}

		const forwardMessage = { ...queryMessage, runtimeId: runtimeId };

		try {
			const forwardStr = JSON.stringify(forwardMessage);
			
			// Check if agent socket is still open
			if (agent.socket.readyState !== WebSocket.OPEN) {
				console.error(`DO ${this.projectId}: Agent socket not open for request ${requestId}`);
				clearTimeout(timeoutId);
				this.pendingRequests.delete(requestId);
				this.agents.delete(agent.id);
				this.sendError(runtimeId, 'Agent connection not available', requestId);
				return;
			}

			agent.socket.send(forwardStr);
			console.log(`DO ${this.projectId}: Request ${requestId} forwarded to agent ${agent.id}`);
			
		} catch (error: any) {
			console.error(`DO ${this.projectId}: Failed to forward request ${requestId}:`, error);
			clearTimeout(timeoutId);
			this.pendingRequests.delete(requestId);
			this.sendError(runtimeId, `Failed to forward message to data agent: ${error.message}`, requestId);
		}
	}

	private async forwardToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: Forwarding response to runtime from agent ${agentId}`);

		if (data.type !== 'query_response') {
			console.error(`DO ${this.projectId}: Message type is not query_response (${data.type})`);
			return;
		}

		const responseData = data as any;
		const requestId = responseData.requestId;

		if (!requestId) {
			console.error(`DO ${this.projectId}: Missing requestId in query response`);
			return;
		}

		// Check if we have a pending request for this response
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			console.warn(`DO ${this.projectId}: No pending request found for response ${requestId} - possible duplicate or timeout`);
			return;
		}

		// Clear timeout and remove from pending
		if (pending.timeoutId) {
			clearTimeout(pending.timeoutId);
		}
		this.pendingRequests.delete(requestId);

		if (!this.runtime) {
			console.warn(`DO ${this.projectId}: No runtime connection for response ${requestId}`);
			return;
		}

		// Verify this response should go to the current runtime
		if (this.runtime.id !== pending.runtimeId) {
			console.warn(`DO ${this.projectId}: Runtime ID mismatch for response ${requestId}. Expected: ${pending.runtimeId}, Current: ${this.runtime.id}`);
			return;
		}

		try {
			// Check if runtime socket is still open
			if (this.runtime.socket.readyState !== WebSocket.OPEN) {
				console.error(`DO ${this.projectId}: Runtime socket not open for response ${requestId}`);
				return;
			}

			const responseStr = JSON.stringify(data);
			this.runtime.socket.send(responseStr);
			console.log(`DO ${this.projectId}: Response ${requestId} sent to runtime successfully`);
			
		} catch (error: any) {
			console.error(`DO ${this.projectId}: Failed to send response ${requestId} to runtime:`, error);
		}
	}

	private async forwardGetDocsToAgent(runtimeId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: Forwarding docs request to agent`);

		if (data.type !== 'get_docs') {
			console.error(`DO ${this.projectId}: Message type is not get_docs (${data.type})`);
			return;
		}

		const docsRequest = data as GetDocsMessage;
		const agent = this.getAvailableAgent();

		if (!agent) {
			console.log(`DO ${this.projectId}: No agent for docs - returning dummy docs`);

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
					console.log(`DO ${this.projectId}: Dummy docs sent to runtime`);
				} catch (error) {
					console.error(`DO ${this.projectId}: Failed to send dummy docs:`, error);
				}
			}
			return;
		}

		const forwardMessage: GetDocsMessage = { ...docsRequest, runtimeId: runtimeId } as any;
		try {
			agent.socket.send(JSON.stringify(forwardMessage));
			console.log(`DO ${this.projectId}: Docs request forwarded to agent`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to forward docs request:`, error);
			this.sendError(runtimeId, `Failed to forward docs request`, docsRequest.requestId);
		}
	}

	private async forwardDocsToRuntime(agentId: string, data: WebSocketMessage): Promise<void> {
		console.log(`DO ${this.projectId}: Forwarding docs to runtime from agent ${agentId}`);

		if (data.type !== 'docs') {
			console.error(`DO ${this.projectId}: Message type is not docs (${data.type})`);
			return;
		}

		if (!this.runtime) {
			console.warn(`DO ${this.projectId}: No runtime connection for docs response`);
			return;
		}

		try {
			this.runtime.socket.send(JSON.stringify(data));
			console.log(`DO ${this.projectId}: Docs forwarded to runtime`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to forward docs to runtime:`, error);
		}
	}

	private async forwardGetProdUIToRuntime(prodId: string, data: GetProdUIMessage): Promise<void> {
		if (!this.runtime) {
			console.warn(`DO ${this.projectId}: No runtime available for prod request ${data.requestId}`);
			this.sendError(prodId, 'No runtime connected', data.requestId);
			return;
		}

		try {
			const forwardMsg = { ...data, prodId };
			this.runtime.socket.send(JSON.stringify(forwardMsg));
			console.log(`DO ${this.projectId}: Forwarded get_prod_ui request ${data.requestId} from prod ${prodId} to runtime`);
		} catch (err) {
			console.error(`DO ${this.projectId}: Failed to forward prod request ${data.requestId}:`, err);
			this.sendError(prodId, 'Failed to forward prod request', data.requestId);
		}
	}

	private async forwardProdUIResponseToProd(senderId: string, data: ProdUIResponse): Promise<void> {
		if (!data.prodId) {
			console.error(`DO ${this.projectId}: prod_ui_response missing prodId`);
			return;
		}

		const prodConn = this.prods.get(data.prodId);
		if (!prodConn) {
			console.warn(`DO ${this.projectId}: No prod client ${data.prodId} found for response ${data.requestId}`);
			return;
		}

		try {
			prodConn.socket.send(JSON.stringify(data));
			console.log(`DO ${this.projectId}: Forwarded prod_ui_response ${data.requestId} to prod ${data.prodId}`);
		} catch (err) {
			console.error(`DO ${this.projectId}: Failed to send prod_ui_response to prod ${data.prodId}:`, err);
		}
	}




	private getAvailableAgent(): Connection | null {
		const availableAgents = Array.from(this.agents.values()).filter(
			agent => agent.socket.readyState === WebSocket.OPEN
		);

		if (availableAgents.length === 0) {
			console.log(`DO ${this.projectId}: No available agents (total: ${this.agents.size})`);
			return null;
		}

		// Return first available agent (you could implement load balancing here)
		return availableAgents[0];
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
			return this.runtime;
		}

		const agent = this.agents.get(clientId);
		if (agent) {
			return agent;
		}

		return null;
	}

	private handleErrorMessage(senderId: string, data: any): void {
		console.warn(`DO ${this.projectId}: Received error from ${senderId}:`, data);
	}

	private handleUnknownMessage(senderId: string, data: any): void {
		console.warn(`DO ${this.projectId}: Unknown message type "${data?.type}" from ${senderId}`);
	}

	private sendError(clientId: string, message: string, requestId?: string): void {
		console.log(`DO ${this.projectId}: Sending error to ${clientId}: ${message}`);

		const connection = this.findConnection(clientId);
		if (!connection) {
			console.error(`DO ${this.projectId}: Cannot send error - no connection for client: ${clientId}`);
			return;
		}

		// Check if connection is still open
		if (connection.socket.readyState !== WebSocket.OPEN) {
			console.error(`DO ${this.projectId}: Cannot send error - connection not open for client: ${clientId}`);
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
			console.log(`DO ${this.projectId}: Error sent successfully to ${clientId}`);
		} catch (error) {
			console.error(`DO ${this.projectId}: Failed to send error message:`, error);
		}
	}

	private broadcastToAdmins(senderId: string, message: WebSocketMessage): void {
		for (const [adminId, adminConn] of this.admins.entries()) {
			// Skip the sender if the sender itself is an admin
			if (adminId === senderId) continue;

			try {
				if (adminConn.socket.readyState === WebSocket.OPEN) {
					adminConn.socket.send(JSON.stringify({
						...message,
						_meta: {
							from: senderId,
							projectId: this.projectId,
							forwardedAt: Date.now()
						}
					}));
					console.log(`DO ${this.projectId}: Forwarded message of type ${message.type} to admin ${adminId}`);
				}
			} catch (err) {
				console.error(`DO ${this.projectId}: Failed to forward message to admin ${adminId}:`, err);
			}
		}
	}


	private async getStatus(): Promise<Response> {
		const status = {
			projectId: this.projectId,
			hasRuntime: !!this.runtime,
			agentCount: this.agents.size,
			lastActivity: this.lastActivity,
			pendingRequests: this.pendingRequests.size,
			connections: {
				runtime: this.runtime ? {
					id: this.runtime.id,
					connectedAt: this.runtime.connectedAt,
					connectedFor: Date.now() - this.runtime.connectedAt,
					socketState: this.runtime.socket.readyState
				} : null,
				agents: Array.from(this.agents.values()).map(agent => ({
					id: agent.id,
					connectedAt: agent.connectedAt,
					connectedFor: Date.now() - agent.connectedAt,
					socketState: agent.socket.readyState
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
			return {
				users: [
					{ id: "1", name: "John Doe", email: "john@example.com", role: "admin", status: "active" },
					{ id: "2", name: "Jane Smith", email: "jane@example.com", role: "user", status: "active" },
					{ id: "3", name: "Bob Wilson", email: "bob@example.com", role: "user", status: "inactive" }
				]
			};
		}

		if (queryLower.includes('posts') || queryLower.includes('post')) {
			return {
				posts: [
					{ id: "1", title: "Getting Started with WebSockets", author: { name: "John Doe" } },
					{ id: "2", title: "Durable Objects Explained", author: { name: "Jane Smith" } },
					{ id: "3", title: "Building Real-time Applications", author: { name: "Bob Wilson" } }
				]
			};
		}

		return {
			message: "Dummy data response",
			query,
			projectId,
			timestamp: new Date().toISOString()
		};
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