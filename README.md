# Project-Scoped WebSocket Broadcaster

A Cloudflare Workers project that implements project-scoped WebSocket broadcasting using Durable Objects. Each project gets its own isolated Durable Object instance for perfect data separation and horizontal scaling, enabling real-time communication between multiple client types.

## Architecture

- **Worker Router**: Routes requests to project-specific Durable Objects based on `projectId`
- **Broadcaster Durable Object**: Each project gets its own Broadcaster instance that manages multiple WebSocket connections
- **Message Routing**: Smart routing based on message `to` field - supports targeted messages to specific clients or client types, plus admin monitoring

## Project Structure

```
src/
├── index.ts                    # Main worker entry point (router)
├── broadcaster/
│   ├── broadcaster.ts          # Broadcaster Durable Object implementation
│   └── types.ts                # TypeScript type definitions
package.json                    # Dependencies
wrangler.toml                  # Cloudflare Workers configuration
tsconfig.json                  # TypeScript configuration
README.md                      # This file
```

## Features

- ✅ **Perfect Project Isolation**: Each project gets its own Durable Object instance
- ✅ **Horizontal Scaling**: Projects scale independently
- ✅ **Smart Message Routing**: Route messages to specific clients by ID or type
- ✅ **Multiple Client Types**: Support for runtime, data-agent, and admin clients
- ✅ **Admin Monitoring**: All routed messages are automatically forwarded to admin clients for observability
- ✅ **Broadcast Capability**: Messages without `to` field broadcast to all other clients
- ✅ **Automatic Cleanup**: Empty DOs clean themselves up after 5 minutes of inactivity
- ✅ **Health Monitoring**: Status and health endpoints for debugging

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Development

```bash
npm run dev
```

### 3. Deploy

```bash
npm run deploy
```

## Usage

### Connecting Runtime Client

```javascript
const ws = new WebSocket('wss://user-websocket.ashish-91e.workers.dev/websocket?type=runtime&projectId=user123');

ws.onopen = () => {
  console.log('Runtime connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data);
};
```

### Connecting Data Agent

```javascript
const ws = new WebSocket('wss://user-websocket.ashish-91e.workers.dev/websocket?type=data-agent&projectId=user123');

ws.onopen = () => {
  console.log('Data agent connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received message:', data);
};
```

### Connecting Admin (for monitoring)

```javascript
const ws = new WebSocket('wss://user-websocket.ashish-91e.workers.dev/websocket?type=admin&projectId=user123');

ws.onopen = () => {
  console.log('Admin connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Admin received:', data);
};
``` 


### Sending Messages

All messages follow a standard format with routing capabilities:

```typescript
interface BroadcastMessage {
  id: string;                    // Unique message ID
  type: string;                  // Message type (custom)
  from: {                        // Sender info (auto-populated with client ID)
    type?: 'runtime' | 'data-agent' | 'admin' | 'system';
    id?: string;                 // Auto-set to sender's client ID
  };
  payload: any;                  // Your message data
  to?: {                         // Optional routing
    type?: 'runtime' | 'data-agent' | 'admin' | 'system';
    id?: string;                 // Specific client ID
  };
}
```

#### Example: Runtime → Specific Agent (by client ID)

```javascript
const message = {
  id: crypto.randomUUID(),
  type: 'graphql_query',
  from: {
    type: 'runtime'
  },
  to: {
    id: 'specific-agent-client-id'  // Send to specific client
  },
  payload: {
    query: 'query { posts { id title } }',
    variables: {}
  }
};

ws.send(JSON.stringify(message));
```

#### Example: Runtime → All Data Agents (by type)

```javascript
const message = {
  id: crypto.randomUUID(),
  type: 'get_docs',
  from: {
    type: 'runtime'
  },
  to: {
    type: 'data-agent'  // Send to all data-agent clients
  },
  payload: {
    requestId: 'docs-123'
  }
};

ws.send(JSON.stringify(message));
```

#### Example: Agent → Runtime (response)

```javascript
const response = {
  id: crypto.randomUUID(),
  type: 'query_response',
  from: {
    type: 'data-agent'
  },
  to: {
    type: 'runtime'
  },
  payload: {
    data: {
      posts: [
        { id: "1", title: "Hello world" },
        { id: "2", title: "Durable Objects are great" }
      ]
    }
  }
};

ws.send(JSON.stringify(response));
```

#### Example: Broadcast to All (no `to` field)

```javascript
const broadcast = {
  id: crypto.randomUUID(),
  type: 'announcement',
  from: {
    type: 'runtime'
  },
  payload: {
    message: 'Server will restart in 5 minutes'
  }
  // No 'to' field - broadcasts to all other connected clients
};

ws.send(JSON.stringify(broadcast));
```

## API Endpoints

### WebSocket Connection
- `GET /websocket?type={runtime|data-agent|admin}&projectId={projectId}`
  - Upgrade to WebSocket connection
  - Routes to project-specific Broadcaster Durable Object
  - Required parameters:
    - `projectId`: Your project identifier
    - `type`: Client type (runtime, data-agent, or admin)

### Status & Health
- `GET /status?projectId={projectId}`
  - Get detailed connection status for a specific project
  - Returns client list with connection info
- `GET /health?projectId={projectId}`
  - Health check for specific project's Broadcaster DO
  - Returns client count and last activity timestamp
- `GET /health`
  - Worker-level health check (no projectId required)

## Message Routing Behavior

### Routing Rules

1. **Targeted by Client ID** (`to.id` is set)
   - Message is sent only to the client with the specified ID
   - Also forwarded to all admin clients for monitoring

2. **Targeted by Client Type** (`to.type` is set, but not `to.id`)
   - Message is sent to all clients of the specified type (except sender)
   - Also forwarded to all admin clients for monitoring

3. **Broadcast** (no `to` field)
   - Message is sent to all other connected clients (except sender)
   - **Not** forwarded to admin clients

### Admin Monitoring

- Admin clients automatically receive copies of all **routed messages** (messages with a `to` field)
- This enables real-time monitoring and debugging of client-to-client communication
- Broadcast messages (without `to` field) are not sent to admins unless they're explicitly targeted

### System Messages

The Broadcaster sends these system messages:

- `connected`: Welcome message when a client connects
  - Includes `clientId`, `projectId`, `clientCount`, and `timestamp`
- `client_left`: Notification when a client disconnects
  - Sent to all remaining clients
- `error`: Error notifications for invalid messages or other issues

## Environment Variables

Set these in your `wrangler.toml` or Cloudflare dashboard:

```toml
[vars]
ENVIRONMENT = "production"
```

## Development

### Type Checking
```bash
npm run type-check
```

### Testing
```bash
npm run test
```

### Local Development
```bash
npm run dev
```

## Deployment

### Using Wrangler CLI
```bash
wrangler deploy
```

### Using GitHub Actions
Add your `CLOUDFLARE_API_TOKEN` to GitHub secrets and use:

```yaml
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Monitoring

### Connection Status
```bash
curl "https://your-worker.your-subdomain.workers.dev/status?projectId=user123"
```

### Health Check
```bash
curl "https://your-worker.your-subdomain.workers.dev/health?projectId=user123"
```

## Benefits of Project-Scoped Architecture

| Aspect | Global Singleton | Project-Scoped DOs |
|--------|-----------------|---------------------|
| **Isolation** | ❌ All projects mixed | ✅ Perfect separation per project |
| **Scaling** | ❌ Single bottleneck | ✅ Horizontal scaling per project |
| **Performance** | ❌ Degrades with load | ✅ Consistent per project |
| **Security** | ❌ Cross-project leakage risk | ✅ Impossible cross-project access |
| **Resource Usage** | ❌ All projects compete | ✅ Dedicated resources per project |
| **Failure Impact** | ❌ Affects all projects | ✅ Isolated failures per project |
| **Routing** | ❌ Application-level | ✅ Built-in with smart routing |

## Troubleshooting

### Common Issues

**WebSocket connection fails**
- Ensure both `projectId` and `type` parameters are provided
- Check that `type` is one of: `runtime`, `data-agent`, or `admin`
- Verify the URL includes the correct protocol (`wss://`)

**Messages not being routed**
- Verify sender and recipient are connected to the same `projectId`
- Check that the `to` field in your message has either `id` or `type` set
- Ensure the target client type exists and is connected
- Check browser/server console logs for routing errors

**Messages going to wrong clients**
- Remember: `from.id` is auto-populated by the server (don't set it yourself)
- Verify `to.id` contains the correct client ID (from the `connected` message)
- For type-based routing, ensure `to.type` matches the recipient's connection type

**Admin not receiving messages**
- Admin clients only receive messages with a `to` field (routed messages)
- Broadcast messages (without `to`) are not sent to admins
- Ensure admin client is connected with `type=admin`

**DO cleanup issues**
- Broadcaster DOs automatically schedule cleanup after 5 minutes of inactivity
- Active connections prevent cleanup
- Empty DOs will clean up when alarm fires

### Debug Logging

Enable verbose logging in development:

```bash
wrangler dev --local --log-level debug
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details