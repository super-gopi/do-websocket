# User-Scoped WebSocket Bridge

A Cloudflare Workers project that implements user-scoped WebSocket bridges using Durable Objects. Each user gets their own isolated Durable Object instance for perfect data separation and horizontal scaling.

## Architecture

- **Worker Router**: Routes requests to user-specific Durable Objects based on `projectId`
- **User WebSocket Bridge**: Each user gets their own Durable Object instance
- **Runtime & Agent Communication**: Both connect to the same user-scoped DO for isolated communication

## Project Structure

```
src/
├── index.ts              # Main worker entry point (router)
├── websocket-bridge.ts   # User-scoped WebSocket bridge Durable Object
├── types.ts              # TypeScript type definitions
package.json              # Dependencies
wrangler.toml            # Cloudflare Workers configuration
tsconfig.json            # TypeScript configuration
README.md                # This file
```

## Features

- ✅ **Perfect User Isolation**: Each user gets their own Durable Object instance
- ✅ **Horizontal Scaling**: Users scale independently
- ✅ **Automatic Cleanup**: Empty DOs clean themselves up after 5 minutes
- ✅ **Runtime ↔ Agent Communication**: Seamless message forwarding within user scope
- ✅ **Dummy Data Support**: Falls back to test data when agents aren't connected
- ✅ **Health Monitoring**: Status endpoints for debugging

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
const ws = new WebSocket('wss://user-websocket.ashish-91e.workers.dev/websocket?type=agent&projectId=user123');

ws.onopen = () => {
  console.log('Agent connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
 console.log('received message:', data);
};
```


### Connecting Admin

```javascript
const ws = new WebSocket('wss://user-websocket.ashish-91e.workers.dev/websocket?type=admin&projectId=3');

ws.onopen = () => {
  console.log('admin connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
 console.log('received message:', data);
};
``` 


### Sending Messages

#### GraphQL Query (Runtime → Agent)

```javascript
const message = {
  type: 'graphql_query',
  requestId: 'req-123',
  projectId: 'user123',
  query: 'query { posts { id title author { name } } }',
  variables: {}
};

ws.send(JSON.stringify(message));
```

#### Query Response (Agent → Runtime)

```javascript
const response = {
  type: 'query_response',
  requestId: 'req-123',
  projectId: 'user123',
  data: { 
    posts: [
      { id: "1", title: "Hello world" },
      { id: "2", title: "Durable Objects are great" }
    ]
  },
  timestamp: Date.now()
};

ws.send(JSON.stringify(response));
```

#### Get Documentation (Runtime → Agent)

```javascript
const docsRequest = {
  type: 'get_docs',
  requestId: 'docs-123',
  projectId: 'user123',
  timestamp: Date.now()
};

ws.send(JSON.stringify(docsRequest));
```

## API Endpoints

### WebSocket Connection
- `GET /websocket?type={runtime|agent}&projectId={projectId}`
  - Upgrade to WebSocket connection
  - Routes to user-specific Durable Object

### Status & Health
- `GET /status?projectId={projectId}`
  - Get connection status for specific user
- `GET /health?projectId={projectId}`
  - Health check for specific user's DO

## Message Types

### Runtime → Agent
- `graphql_query`: Execute GraphQL query
- `get_docs`: Get database documentation
- `ping`: Heartbeat

### Agent → Runtime  
- `query_response`: GraphQL query result
- `docs`: Database documentation
- `pong`: Heartbeat response

### System Messages
- `connected`: Welcome message on connection
- `error`: Error notifications

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

## Benefits over Single DO Architecture

| Aspect | Single DO | User-Scoped DOs |
|--------|-----------|-----------------|
| **Isolation** | ❌ All users mixed | ✅ Perfect separation |
| **Scaling** | ❌ Single bottleneck | ✅ Horizontal scaling |
| **Performance** | ❌ Degrades with users | ✅ Consistent per user |
| **Security** | ❌ Data leakage risk | ✅ Impossible cross-user access |
| **Resource Usage** | ❌ All users compete | ✅ Dedicated resources |
| **Failure Impact** | ❌ Affects all users | ✅ Isolated failures |

## Troubleshooting

### Common Issues

**WebSocket connection fails**
- Ensure `projectId` parameter is provided
- Check that the URL includes the correct protocol (`wss://`)

**Messages not forwarding**
- Verify both runtime and agent are connected to the same `projectId`
- Check console logs for routing errors

**Empty responses**
- Normal behavior when no agent is connected
- System will return dummy data for testing

**DO cleanup issues**
- DOs automatically clean up after 5 minutes of inactivity
- Active connections prevent cleanup

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