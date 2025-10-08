export interface BroadcastMessage {
    id:string
	type: string;
	from:{
		type:'runtime' | 'data-agent' | 'admin' | 'system';
		id?: string;
	};
	payload : any;
	to?:{
		type:'runtime' | 'data-agent' | 'admin' | 'system';
		id?: string;
	};
}

export interface Env {
	BROADCASTER: DurableObjectNamespace;
}

export interface BroadcastClient {
	id: string;
	socket: WebSocket;
	type: string;
	connectedAt: number;
	metadata?: {
		userAgent: string | null;
		origin: string | null;
	};
}