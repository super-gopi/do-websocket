export const generateDummyData = (query: string, projectId: string) => {
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

export const generateDummyDocs = (projectId: string) => {
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
