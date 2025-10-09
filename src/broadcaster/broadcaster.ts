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
		console.log(`Broadcaster: Initialized for projectId=${this.projectId}`);
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
		console.log(`Broadcaster ${this.projectId}: ${request.method} ${url.pathname}`);

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

			server.accept();

			const clientId = crypto.randomUUID();

			const broadcastClient: BroadcastClient = {
				id: clientId,
				socket: server,
				connectedAt: Date.now(),
				type: type,
				metadata: {
					userAgent: request.headers.get('User-Agent'),
					origin: request.headers.get('Origin')
				}
			};

			this.clients.set(clientId, broadcastClient);
			this.lastActivity = Date.now();

			console.log(`Broadcaster ${this.projectId}: Client ${clientId} connected (total: ${this.clients.size})`);

			// Event listeners
			server.addEventListener('message', (event: MessageEvent) => {
				this.handleMessage(clientId, event.data as string);
			});

			server.addEventListener('close', (event) => {
				console.log(`Broadcaster ${this.projectId}: Client ${clientId} disconnected`);
				this.handleDisconnection(clientId);
			});

			server.addEventListener('error', (event: Event) => {
				console.error(`Broadcaster ${this.projectId}: WebSocket error for client ${clientId}`);
				this.handleDisconnection(clientId);
			});

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

	private handleMessage(senderId: string, message: string): void {
		console.log(`Broadcaster ${this.projectId}: Message from client ${senderId}`);

		if (!message || typeof message !== 'string') {
			console.error(`Broadcaster ${this.projectId}: Invalid message format`);
			return;
		}

		let ws_json_message:any = {};

		try {
			ws_json_message = JSON.parse(message) as BroadcastMessage;
		} catch (error) {
			console.error(`Broadcaster ${this.projectId}: Failed to parse message:`, error);
			this.sendError(senderId, 'Invalid JSON message format');
			return;
		}

		//adding the clientid as from.id
		if(ws_json_message.from && typeof ws_json_message.from === 'object') {
			ws_json_message.from.id = senderId;		
		}
		// ws_json_message.from.id = senderId;		

		const targetType = ws_json_message.to?.type ;
		const targetId = ws_json_message.to?.id;

		if(targetId || targetType) {
			//route based on to.type
			
			console.log('targetId', targetId);
			if(targetId) {
				const targetClient = this.clients.get(targetId);
				if(targetClient) {
					targetClient.socket.send(JSON.stringify(ws_json_message));
				}
			} 
			else {
				for (const [clientId, client] of this.clients.entries()) {
					if (clientId !== senderId && client.socket.readyState === WebSocket.OPEN) {
						if (client.type === targetType) {
							try {
								client.socket.send(JSON.stringify(ws_json_message));
							} catch (error) {
								console.error(`Broadcaster ${this.projectId}: Failed to send to client ${clientId}:`, error);
							}
						}
					}
				}
			}

			//send to admin 
			console.log('sending to admin');
			this.broadcastToadmin(senderId, ws_json_message);
		} 
		//if to is not present then broadcast to others
		else {
			this.broadcastToOthers(senderId, ws_json_message);
		}
	}

	private handleDisconnection(clientId: string): void {
		this.clients.delete(clientId);
		this.lastActivity = Date.now();

		console.log(`Broadcaster ${this.projectId}: Client ${clientId} removed (remaining: ${this.clients.size})`);

		// Notify other clients about disconnection
		const leaveMessage: BroadcastMessage = {
			id: crypto.randomUUID(),
			type: 'client_left',
			from: {
				type: 'system'
			},
			payload: {
				clientId: clientId,
				projectId: this.projectId,
				clientCount: this.clients.size,
				timestamp: Date.now()
			}
		};
		this.broadcastToAll(leaveMessage);

		// Schedule cleanup if room is empty
		if (this.clients.size === 0) {
			this.scheduleCleanup();
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

	private broadcastToAll(message: any): void {
		const messageStr = JSON.stringify(message);

		for (const [clientId, client] of this.clients.entries()) {
			if (client.socket.readyState === WebSocket.OPEN) {
				try {
					client.socket.send(messageStr);
				} catch (error) {
					console.error(`Broadcaster ${this.projectId}: Failed to send to client ${clientId}:`, error);
				}
			}
		}
	}

	private broadcastToadmin(senderId: string, message: any): void {
		const messageStr = typeof message === 'string' ? message : JSON.stringify(message);

		for (const [clientId, client] of this.clients.entries()) {
			if (clientId !== senderId && client.type === 'admin' && client.socket.readyState === WebSocket.OPEN) {
				try {
					client.socket.send(messageStr);
					console.log(`Broadcaster ${this.projectId}: Forwarded message of type ${message.type} to admin ${clientId}`);
				} catch (error) {
					console.error(`Broadcaster ${this.projectId}: Failed to send to client ${clientId}:`, error);
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
		console.log(`Broadcaster ${this.projectId}: Scheduled cleanup in 5 minutes`);
	}

	async alarm(): Promise<void> {
		if (this.clients.size === 0) {
			console.log(`Broadcaster ${this.projectId}: Alarm triggered - room is empty, cleaning up`);
		}
	}

	private async getStatus(): Promise<Response> {
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
}
