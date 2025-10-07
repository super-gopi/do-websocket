import { Env } from '../types';
import { BroadcastMessage } from './types';

interface BroadcastClient {
	id: string;
	socket: WebSocket;
	connectedAt: number;
	metadata?: {
		userAgent: string | null;
		origin: string | null;
	};
}

export class Broadcaster implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private clients: Map<string, BroadcastClient> = new Map();
	private userId: string;
	private lastActivity: number;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.lastActivity = Date.now();
		this.userId = state.id.name || 'unknown';
		console.log(`Broadcaster: Initialized for userId=${this.userId}`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const urlUserId = url.searchParams.get('userId');

		if (!urlUserId) {
			return new Response(JSON.stringify({
				error: 'Missing userId parameter',
				required: 'Please provide ?userId=your-user-id'
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		this.userId = urlUserId;
		console.log(`Broadcaster ${this.userId}: ${request.method} ${url.pathname}`);

		if (url.pathname === '/websocket') {
			return this.handleWebSocketUpgrade(request);
		}

		if (url.pathname === '/status') {
			return this.getStatus();
		}

		if (url.pathname === '/health') {
			return new Response(JSON.stringify({
				status: 'healthy',
				userId: this.userId,
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

		try {
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			server.accept();

			const clientId = crypto.randomUUID();

			const broadcastClient: BroadcastClient = {
				id: clientId,
				socket: server,
				connectedAt: Date.now(),
				metadata: {
					userAgent: request.headers.get('User-Agent'),
					origin: request.headers.get('Origin')
				}
			};

			this.clients.set(clientId, broadcastClient);
			this.lastActivity = Date.now();

			console.log(`Broadcaster ${this.userId}: Client ${clientId} connected (total: ${this.clients.size})`);

			// Event listeners
			server.addEventListener('message', (event: MessageEvent) => {
				this.handleMessage(clientId, event.data as string);
			});

			server.addEventListener('close', (event) => {
				console.log(`Broadcaster ${this.userId}: Client ${clientId} disconnected`);
				this.handleDisconnection(clientId);
			});

			server.addEventListener('error', (event: Event) => {
				console.error(`Broadcaster ${this.userId}: WebSocket error for client ${clientId}`);
				this.handleDisconnection(clientId);
			});

			// Send welcome message
			const welcomeMessage: BroadcastMessage = {
				id: crypto.randomUUID(),
				type: 'connected',
				from: 'system',
				payload: {
					clientId: clientId,
					userId: this.userId,
					message: `Connected to user ${this.userId}`,
					clientCount: this.clients.size,
					timestamp: Date.now()
				}
			};

			server.send(JSON.stringify(welcomeMessage));

			// Notify other clients about new connection
			// const joinMessage: BroadcastMessage = {
			// 	id: crypto.randomUUID(),
			// 	type: 'client_joined',
			// 	from: 'system',
			// 	payload: {
			// 		clientId: clientId,
			// 		userId: this.userId,
			// 		clientCount: this.clients.size,
			// 		timestamp: Date.now()
			// 	}
			// };
			// this.broadcastToOthers(clientId, joinMessage);

			return new Response(null, {
				status: 101,
				webSocket: client
			});

		} catch (error: any) {
			console.error(`Broadcaster ${this.userId}: WebSocket upgrade error:`, error);
			return new Response(JSON.stringify({
				error: 'WebSocket upgrade failed',
				details: error.message,
				userId: this.userId
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	private handleMessage(senderId: string, message: string): void {
		console.log(`Broadcaster ${this.userId}: Message from client ${senderId}`);

		if (!message || typeof message !== 'string') {
			console.error(`Broadcaster ${this.userId}: Invalid message format`);
			return;
		}

		try {
			const data: BroadcastMessage = JSON.parse(message);
			this.lastActivity = Date.now();

			// Set the 'from' field to the sender's clientId
			const broadcastMessage: BroadcastMessage = {
				...data,
				// from: senderId
			};

			// Broadcast to all other clients
			this.broadcastToOthers(senderId, broadcastMessage);

			console.log(`Broadcaster ${this.userId}: Broadcasted message from ${senderId} to ${this.clients.size - 1} clients`);

		} catch (error: any) {
			console.error(`Broadcaster ${this.userId}: Failed to parse message:`, error);
			this.sendError(senderId, 'Invalid JSON message format');
		}
	}

	private handleDisconnection(clientId: string): void {
		this.clients.delete(clientId);
		this.lastActivity = Date.now();

		console.log(`Broadcaster ${this.userId}: Client ${clientId} removed (remaining: ${this.clients.size})`);

		// Notify other clients about disconnection
		const leaveMessage: BroadcastMessage = {
			id: crypto.randomUUID(),
			type: 'client_left',
			from: 'system',
			payload: {
				clientId: clientId,
				userId: this.userId,
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
		const messageStr = JSON.stringify(message);

		for (const [clientId, client] of this.clients.entries()) {
			if (clientId !== senderId && client.socket.readyState === WebSocket.OPEN) {
				try {
					client.socket.send(messageStr);
				} catch (error) {
					console.error(`Broadcaster ${this.userId}: Failed to send to client ${clientId}:`, error);
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
					console.error(`Broadcaster ${this.userId}: Failed to send to client ${clientId}:`, error);
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
				from: 'system',
				payload: {
					message,
					userId: this.userId,
					timestamp: Date.now()
				}
			};
			client.socket.send(JSON.stringify(errorMessage));
		} catch (error) {
			console.error(`Broadcaster ${this.userId}: Failed to send error to client ${clientId}:`, error);
		}
	}

	private async scheduleCleanup(): Promise<void> {
		const cleanupTime = Date.now() + 5 * 60 * 1000; // 5 minutes
		await this.state.storage.setAlarm(cleanupTime);
		console.log(`Broadcaster ${this.userId}: Scheduled cleanup in 5 minutes`);
	}

	async alarm(): Promise<void> {
		if (this.clients.size === 0) {
			console.log(`Broadcaster ${this.userId}: Alarm triggered - room is empty, cleaning up`);
		}
	}

	private async getStatus(): Promise<Response> {
		const status = {
			userId: this.userId,
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
