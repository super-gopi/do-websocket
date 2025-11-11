import { BroadcastClient, BroadcastMessage, Env } from './types';



export class Broadcaster implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private clients: Map<string, BroadcastClient> = new Map();
	private projectId: string;
	private lastActivity: number;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.lastActivity = Date.now();
		this.projectId = state.id.name || 'unknown';
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const urlProjectId = url.searchParams.get('projectId');

		if (!urlProjectId) {
			return new Response(JSON.stringify({
				error: 'Missing projectId parameter',
				required: 'Please provide ?projectId=your-project-id'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		this.projectId = urlProjectId;

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
				clientCount: this.clients.size,
				lastActivity: this.lastActivity,
				timestamp: Date.now()
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response('Not found', { status: 404 });
	}

	private async handleWebSocketUpgrade(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');

		if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
			return new Response('Expected Upgrade: websocket', { status: 426 });
		}

		const url = new URL(request.url);
		const type = url.searchParams.get('type');

		if(!type ) {
			return new Response('Missing type parameter', { status: 400 });
		}

		if(['runtime','data-agent','admin'].indexOf(type) === -1) {
			return new Response('Invalid type parameter', { status: 400 });
		}

		try {
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			const clientId = crypto.randomUUID();
			const connectedAt = Date.now();

			// Accept the WebSocket for hibernation
			this.state.acceptWebSocket(server);

			// Attach metadata using serializeAttachment for hibernatable WebSockets
			const clientMetadata = {
				clientId: clientId,
				type: type,
				connectedAt: connectedAt,
				userAgent: request.headers.get('User-Agent') || 'unknown',
				origin: request.headers.get('Origin') || 'unknown'
			};
			(server as any).serializeAttachment(clientMetadata);

			const broadcastClient: BroadcastClient = {
				id: clientId,
				socket: server,
				connectedAt: connectedAt,
				type: type,
				metadata: {
					userAgent: request.headers.get('User-Agent'),
					origin: request.headers.get('Origin')
				}
			};

			this.clients.set(clientId, broadcastClient);
			this.lastActivity = Date.now();

			// Send welcome message
			const welcomeMessage: BroadcastMessage = {
				id: crypto.randomUUID(),
				type: 'connected',
				from: {
					type: 'system'
				},
				payload: {
					clientId: clientId,
					projectId: this.projectId,
					message: `Connected to project ${this.projectId}`,
					clientCount: this.clients.size,
					timestamp: Date.now()
				}
			};

			server.send(JSON.stringify(welcomeMessage));

			return new Response(null, {
				status: 101,
				webSocket: client
			});

		} catch (error: any) {
			console.error(`Broadcaster ${this.projectId}: WebSocket upgrade error:`, error);
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


	private broadcastToOthers(senderId: string, message: any): void {
		const messageStr = typeof message === 'string' ? message : JSON.stringify(message);

		for (const [clientId, client] of this.clients.entries()) {
			if (clientId !== senderId && client.socket.readyState === WebSocket.OPEN) {
				try {
					client.socket.send(messageStr);
				} catch (error) {
					console.error(`Broadcaster ${this.projectId}: Failed to send to client ${clientId}:`, error);
				}
			}
		}
	}


	private broadcastToadminOptimized(senderId: string, messageStr: string): void {
		for (const [clientId, client] of this.clients.entries()) {
			if (clientId !== senderId && client.type === 'admin' && client.socket.readyState === WebSocket.OPEN) {
				try {
					client.socket.send(messageStr);
				} catch (error) {
					console.error(`Broadcaster ${this.projectId}: Failed to send to admin:`, error);
				}
			}
		}
	}

	private sendError(clientId: string, message: string): void {
		const client = this.clients.get(clientId);
		if (!client || client.socket.readyState !== WebSocket.OPEN) {
			return;
		}

		try {
			const errorMessage: BroadcastMessage = {
				id: crypto.randomUUID(),
				type: 'error',
				from: {
					type: 'system'
				},
				payload: {
					message,
					projectId: this.projectId,
					timestamp: Date.now()
				}
			};
			client.socket.send(JSON.stringify(errorMessage));
		} catch (error) {
			console.error(`Broadcaster ${this.projectId}: Failed to send error to client ${clientId}:`, error);
		}
	}

	private async scheduleCleanup(): Promise<void> {
		const cleanupTime = Date.now() + 5 * 60 * 1000; // 5 minutes
		await this.state.storage.setAlarm(cleanupTime);
	}

	async alarm(): Promise<void> {
		if (this.clients.size === 0) {
			// DO will naturally hibernate and stop consuming CPU/duration
		}
	}

	private async getStatus(): Promise<Response> {
		// Sync clients to get accurate status
		this.syncClientsFromWebSockets();

		const status = {
			projectId: this.projectId,
			clientCount: this.clients.size,
			lastActivity: this.lastActivity,
			clients: Array.from(this.clients.values()).map(client => ({
				id: client.id,
				connectedAt: client.connectedAt,
				connectedFor: Date.now() - client.connectedAt,
				socketState: client.socket.readyState,
				metadata: client.metadata
			})),
			timestamp: Date.now()
		};

		return new Response(JSON.stringify(status, null, 2), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Hibernatable WebSocket Handlers
	// These methods replace event listeners and enable automatic hibernation

	/**
	 * Sync the clients Map from active WebSockets
	 * This is necessary after hibernation wakeup
	 */
	private syncClientsFromWebSockets(): void {
		const activeSockets = this.state.getWebSockets();
		const activeClientIds = new Set<string>();

		for (const ws of activeSockets) {
			const metadata = (ws as any).deserializeAttachment();
			if (metadata && typeof metadata === 'object' && metadata.clientId && metadata.type) {
				activeClientIds.add(metadata.clientId);

				// Add to clients Map if not already present
				if (!this.clients.has(metadata.clientId)) {
					this.clients.set(metadata.clientId, {
						id: metadata.clientId,
						socket: ws,
						connectedAt: metadata.connectedAt || Date.now(),
						type: metadata.type,
						metadata: {
							userAgent: metadata.userAgent || 'unknown',
							origin: metadata.origin || 'unknown'
						}
					});
				}
			}
		}

		// Remove disconnected clients from Map
		for (const clientId of this.clients.keys()) {
			if (!activeClientIds.has(clientId)) {
				this.clients.delete(clientId);
			}
		}
	}

	/**
	 * Extract client metadata from WebSocket attachment
	 */
	private getClientInfoFromWebSocket(ws: WebSocket): { clientId: string; type: string } | null {
		const metadata = (ws as any).deserializeAttachment();
		if (!metadata || typeof metadata !== 'object') {
			return null;
		}

		const clientId = metadata.clientId;
		const type = metadata.type;

		return clientId && type ? { clientId, type } : null;
	}

	/**
	 * Called when a WebSocket message is received
	 * The DO automatically wakes up from hibernation to handle this
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		this.lastActivity = Date.now();

		// Sync clients after hibernation wakeup
		this.syncClientsFromWebSockets();

		const clientInfo = this.getClientInfoFromWebSocket(ws);
		if (!clientInfo) {
			console.error(`Broadcaster ${this.projectId}: Could not extract client info from WebSocket`);
			return;
		}

		const senderId = clientInfo.clientId;

		// Convert ArrayBuffer to string if needed
		const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message);

		if (!messageStr || typeof messageStr !== 'string') {
			console.error(`Broadcaster ${this.projectId}: Invalid message format`);
			return;
		}

		let ws_json_message: any = {};

		try {
			ws_json_message = JSON.parse(messageStr) as BroadcastMessage;
		} catch (error) {
			console.error(`Broadcaster ${this.projectId}: Failed to parse message:`, error);
			this.sendError(senderId, 'Invalid JSON message format');
			return;
		}

		// Adding the clientid as from.id
		if (ws_json_message.from && typeof ws_json_message.from === 'object') {
			ws_json_message.from.id = senderId;
		}

		const targetType = ws_json_message.to?.type;
		const targetId = ws_json_message.to?.id;

		if (targetId || targetType) {
			// Route based on to.type
			const messageToSend = JSON.stringify(ws_json_message);

			if (targetId) {
				const targetClient = this.clients.get(targetId);
				if (targetClient && targetClient.socket.readyState === WebSocket.OPEN) {
					try {
						targetClient.socket.send(messageToSend);
					} catch (error) {
						console.error(`Broadcaster ${this.projectId}: Failed to send to target:`, error);
					}
				}
			} else {
				for (const [clientId, client] of this.clients.entries()) {
					if (clientId !== senderId && client.socket.readyState === WebSocket.OPEN) {
						if (client.type === targetType) {
							try {
								client.socket.send(messageToSend);
							} catch (error) {
								console.error(`Broadcaster ${this.projectId}: Failed to send to client ${clientId}:`, error);
							}
						}
					}
				}
			}

			// Send to admin (for monitoring routed messages)
			this.broadcastToadminOptimized(senderId, messageToSend);
		}
		// If to is not present then broadcast to others
		else {
			this.broadcastToOthers(senderId, ws_json_message);
		}
	}

	/**
	 * Called when a WebSocket connection is closed
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		const clientInfo = this.getClientInfoFromWebSocket(ws);
		if (!clientInfo) {
			return;
		}

		this.clients.delete(clientInfo.clientId);
		this.lastActivity = Date.now();

		// Schedule cleanup if room is empty
		if (this.clients.size === 0) {
			this.scheduleCleanup();
		}
	}

	/**
	 * Called when a WebSocket encounters an error
	 */
	async webSocketError(ws: WebSocket, error: any): Promise<void> {
		const clientInfo = this.getClientInfoFromWebSocket(ws);
		if (clientInfo) {
			console.error(`Broadcaster ${this.projectId}: WebSocket error for client ${clientInfo.clientId}:`, error);
		} else {
			console.error(`Broadcaster ${this.projectId}: WebSocket error:`, error);
		}
	}
}
