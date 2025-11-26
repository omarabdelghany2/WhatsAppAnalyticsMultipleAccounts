const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

// Load configuration
let config;
try {
    const configFile = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    config = JSON.parse(configFile);
} catch (error) {
    config = {
        groups: ["Army"],
        checkInterval: 60000,
        messageLimit: 15,
        detectJoinsLeaves: true,
        port: 3000
    };
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
}

const PORT = config.port || 3000;
const CHECK_INTERVAL = config.checkInterval || 60000;
const MESSAGE_LIMIT = config.messageLimit || 15;
const DETECT_JOINS_LEAVES = config.detectJoinsLeaves !== false;
const GROUP_NAMES = config.groups || ["Army"];

// Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
    noServer: true  // Handle upgrades manually for Railway compatibility
});

// Handle WebSocket upgrade explicitly for Railway
server.on('upgrade', (request, socket, head) => {
    console.log(`📡 WebSocket upgrade request received: ${request.url}`);
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    console.log(`   Path: ${pathname}`);

    if (pathname === '/ws') {
        console.log('✅ Upgrading to WebSocket on /ws path');
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        console.log(`❌ Rejected upgrade for path: ${pathname}`);
        socket.destroy();
    }
});

app.use(cors());
app.use(express.json());

// Serve frontend static files in production
if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
    if (fs.existsSync(frontendDistPath)) {
        app.use(express.static(frontendDistPath));
        console.log('📦 Serving frontend from:', frontendDistPath);
    }
}

// Determine data directory (use Railway volume in production, local in development)
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT
    ? '/app/data'  // Railway volume mount path
    : __dirname;   // Local development

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
}

// Initialize SQLite database
const dbPath = path.join(DATA_DIR, 'whatsapp_analytics.db');
console.log(`📊 Database path: ${dbPath}`);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('📊 SQLite database connected');
        initializeDatabase();
    }
});

// Create tables if they don't exist
function initializeDatabase() {
    db.serialize(() => {
        // Messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                group_name TEXT NOT NULL,
                sender TEXT NOT NULL,
                sender_id TEXT,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Events table
        db.run(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id TEXT NOT NULL,
                group_name TEXT NOT NULL,
                member_id TEXT NOT NULL,
                member_name TEXT NOT NULL,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                date TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add date column to existing events table if it doesn't exist
        db.run(`
            ALTER TABLE events ADD COLUMN date TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding date column:', err);
            } else if (!err) {
                console.log('✅ Added date column to events table');
                // Populate date for existing records
                db.run(`
                    UPDATE events
                    SET date = substr(timestamp, 1, 10)
                    WHERE date IS NULL
                `);
            }
        });

        // Add sender_id column to existing messages table if it doesn't exist
        db.run(`
            ALTER TABLE messages ADD COLUMN sender_id TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding sender_id column:', err);
            } else if (!err) {
                console.log('✅ Added sender_id column to messages table');
            }
        });

        // Create indexes for better query performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_group_id ON events(group_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_date_member ON events(date, member_id)`);

        console.log('✅ Database tables initialized');
    });
}

// In-memory storage for group info (lightweight, doesn't need persistence)
const groupInfoStore = new Map(); // groupId -> { name, id, memberCount }

// WebSocket clients
const wsClients = new Set();

// WhatsApp client
let client;
let monitoredGroups = new Map();
let isClientReady = false;
let currentQRCode = null;
let authStatus = 'initializing'; // 'initializing', 'qr_ready', 'authenticating', 'authenticated', 'failed'

console.log('===============================================');
console.log('   WhatsApp Analytics API Server');
console.log('===============================================');
console.log(`Port: ${PORT}`);
console.log(`Monitoring groups: ${GROUP_NAMES.join(', ')}`);
console.log(`Check interval: ${CHECK_INTERVAL / 1000} seconds`);
console.log(`Message limit: ${MESSAGE_LIMIT}`);
console.log(`Detect joins/leaves: ${DETECT_JOINS_LEAVES ? 'Yes' : 'No'}\n`);

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappConnected: isClientReady,
        authStatus: authStatus,
        monitoredGroups: Array.from(groupInfoStore.values()),
        timestamp: new Date().toISOString()
    });
});

// Get QR code for authentication
app.get('/api/auth/qr', async (req, res) => {
    // If client was destroyed after logout, reinitialize it
    if (!client) {
        console.log('🔄 Client not found, reinitializing...');
        try {
            await initClient();
            await client.initialize();
            // Wait a bit for QR to be generated
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.error('Error reinitializing client:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to initialize WhatsApp client'
            });
        }
    }

    if (isClientReady) {
        return res.json({
            success: true,
            authenticated: true,
            message: 'Already authenticated'
        });
    }

    if (!currentQRCode) {
        return res.json({
            success: false,
            authenticated: false,
            qr: null,
            authStatus: authStatus,
            message: 'QR code not yet generated. Please wait...'
        });
    }

    res.json({
        success: true,
        authenticated: false,
        qr: currentQRCode,
        authStatus: authStatus,
        message: 'Scan this QR code with WhatsApp'
    });
});

// Get authentication status
app.get('/api/auth/status', (req, res) => {
    res.json({
        success: true,
        authenticated: isClientReady,
        authStatus: authStatus,
        timestamp: new Date().toISOString()
    });
});

// Logout and clear all data
app.post('/api/auth/logout', async (req, res) => {
    try {
        console.log('🚪 Logging out and clearing all data...');

        // Clear all messages from database
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM messages', (err) => {
                if (err) {
                    console.error('Error clearing messages:', err);
                    reject(err);
                } else {
                    console.log('✓ Messages cleared');
                    resolve();
                }
            });
        });

        // Clear all events from database
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM events', (err) => {
                if (err) {
                    console.error('Error clearing events:', err);
                    reject(err);
                } else {
                    console.log('✓ Events cleared');
                    resolve();
                }
            });
        });

        // Clear monitored groups from memory
        monitoredGroups.clear();
        groupInfoStore.clear();
        console.log('✓ Monitored groups cleared');

        // Update config.json to remove all groups
        const configPath = path.join(__dirname, 'config.json');
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        currentConfig.groups = [];
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
        console.log('✓ Config file cleared');

        // Logout from WhatsApp
        if (client && isClientReady) {
            try {
                await client.logout();
                console.log('✓ Logged out from WhatsApp');
            } catch (logoutError) {
                console.error('Error logging out from WhatsApp:', logoutError);
                // Continue anyway, we'll still clear the session
            }
            isClientReady = false;
            authStatus = 'logged_out';
        }

        // Destroy the client instance
        if (client) {
            try {
                await client.destroy();
                console.log('✓ WhatsApp client destroyed');
            } catch (destroyError) {
                console.error('Error destroying client:', destroyError);
            }
            client = null;
        }

        // Wait a moment for Chromium to fully release file locks
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Delete session folder for faster next login
        const sessionPath = path.join(DATA_DIR, '.wwebjs_auth');
        if (fs.existsSync(sessionPath)) {
            try {
                // Force remove the SingletonLock file first if it exists
                const lockFile = path.join(sessionPath, 'session', 'SingletonLock');
                if (fs.existsSync(lockFile)) {
                    try {
                        fs.unlinkSync(lockFile);
                        console.log('✓ Removed Chromium lock file');
                    } catch (e) {
                        console.log('⚠️  Could not remove lock file, continuing...');
                    }
                }

                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log('✓ Session files deleted');
            } catch (sessionError) {
                console.error('Error deleting session files:', sessionError);
                // Continue anyway
            }
        }

        res.json({
            success: true,
            message: 'Logged out successfully and all data cleared'
        });
    } catch (error) {
        console.error('Error during logout:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to logout'
        });
    }
});

// Get all groups being monitored
app.get('/api/groups', (req, res) => {
    const groups = Array.from(groupInfoStore.values());
    res.json({
        success: true,
        groups: groups,
        count: groups.length
    });
});

// Get all members of a specific group with their phone numbers
app.get('/api/groups/:groupId/members', async (req, res) => {
    try {
        const groupId = req.params.groupId;

        if (!client || !client.info) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client not ready'
            });
        }

        // Get the group chat
        const chat = await client.getChatById(groupId);

        if (!chat.isGroup) {
            return res.status(400).json({
                success: false,
                error: 'Chat is not a group'
            });
        }

        // Get all participants
        const participants = chat.participants;

        // Fetch contact details for each participant
        const members = await Promise.all(
            participants.map(async (participant) => {
                try {
                    const contact = await client.getContactById(participant.id._serialized);
                    const phone = contact.number || participant.id.user;
                    const name = contact.pushname || contact.name || phone;

                    return {
                        id: participant.id._serialized,
                        phone: phone,
                        name: name,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };
                } catch (error) {
                    // Fallback if contact fetch fails
                    const phone = participant.id.user;
                    return {
                        id: participant.id._serialized,
                        phone: phone,
                        name: phone,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };
                }
            })
        );

        // Sort by name
        members.sort((a, b) => a.name.localeCompare(b.name));

        res.json({
            success: true,
            groupId: groupId,
            groupName: chat.name,
            members: members,
            totalMembers: members.length
        });

    } catch (error) {
        console.error('Error fetching group members:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get messages from all groups
app.get('/api/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Get total count
    db.get('SELECT COUNT(*) as total FROM messages', (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated messages (sorted by timestamp DESC - newest first)
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [limit, offset], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({
                success: true,
                messages: rows,
                total: countRow.total,
                limit: limit,
                offset: offset,
                hasMore: offset + limit < countRow.total
            });
        });
    });
});

// Get messages from a specific group
app.get('/api/messages/:groupId', (req, res) => {
    const groupId = req.params.groupId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const groupInfo = groupInfoStore.get(groupId);

    // Get total count for this group
    db.get('SELECT COUNT(*) as total FROM messages WHERE group_id = ?', [groupId], (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated messages for this group
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE group_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [groupId, limit, offset], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({
                success: true,
                groupName: groupInfo?.name || 'Unknown',
                messages: rows,
                total: countRow.total,
                limit: limit,
                offset: offset,
                hasMore: offset + limit < countRow.total
            });
        });
    });
});

// Get events (joins/leaves) from all groups
app.get('/api/events', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const date = req.query.date; // Optional: filter by specific date (YYYY-MM-DD) or date range (YYYY-MM-DD,YYYY-MM-DD)
    const memberId = req.query.memberId; // Optional: filter by member phone number

    // Build WHERE clause dynamically
    let whereConditions = [];
    let params = [];

    if (date) {
        // Check if date is a range (contains comma)
        if (date.includes(',')) {
            const [startDate, endDate] = date.split(',');
            whereConditions.push('date BETWEEN ? AND ?');
            params.push(startDate, endDate);
        } else {
            // Single date
            whereConditions.push('date = ?');
            params.push(date);
        }
    }

    if (memberId) {
        whereConditions.push('member_id = ?');
        params.push(memberId);
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // Get total count with filters
    db.get(`SELECT COUNT(*) as total FROM events ${whereClause}`, params, (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated events with filters
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, member_id as memberId,
                   member_name as memberName, type, timestamp, date
            FROM events
            ${whereClause}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({
                success: true,
                events: rows,
                total: countRow.total,
                limit: limit,
                offset: offset,
                hasMore: offset + limit < countRow.total,
                filters: { date, memberId }
            });
        });
    });
});

// Get events from a specific group
app.get('/api/events/:groupId', (req, res) => {
    const groupId = req.params.groupId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const groupInfo = groupInfoStore.get(groupId);

    // Get total count for this group
    db.get('SELECT COUNT(*) as total FROM events WHERE group_id = ?', [groupId], (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated events for this group
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, member_id as memberId,
                   member_name as memberName, type, timestamp, date
            FROM events
            WHERE group_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [groupId, limit, offset], (err, rows) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({
                success: true,
                groupName: groupInfo?.name || 'Unknown',
                events: rows,
                total: countRow.total,
                limit: limit,
                offset: offset,
                hasMore: offset + limit < countRow.total
            });
        });
    });
});

// Search messages
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    const groupId = req.query.groupId;
    const limit = parseInt(req.query.limit) || 100;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: 'Query parameter "q" is required'
        });
    }

    const searchPattern = `%${query}%`;
    let sqlQuery, params;

    if (groupId) {
        // Search in specific group
        sqlQuery = `
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE group_id = ? AND (message LIKE ? OR sender LIKE ?)
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        params = [groupId, searchPattern, searchPattern, limit];
    } else {
        // Search in all groups
        sqlQuery = `
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE message LIKE ? OR sender LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        params = [searchPattern, searchPattern, limit];
    }

    db.all(sqlQuery, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        res.json({
            success: true,
            query: query,
            results: rows,
            total: rows.length,
            hasMore: rows.length === limit
        });
    });
});

// Get statistics
app.get('/api/stats', (req, res) => {
    const stats = {
        groups: [],
        totalMessages: 0,
        totalEvents: 0
    };

    // Get total counts
    db.get('SELECT COUNT(*) as total FROM messages', (err, msgCountRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        db.get('SELECT COUNT(*) as total FROM events', (err, eventCountRow) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            stats.totalMessages = msgCountRow.total;
            stats.totalEvents = eventCountRow.total;

            // Process each group
            const groupIds = Array.from(groupInfoStore.keys());
            let processed = 0;

            if (groupIds.length === 0) {
                return res.json({
                    success: true,
                    stats: stats,
                    timestamp: new Date().toISOString()
                });
            }

            groupIds.forEach(groupId => {
                const groupInfo = groupInfoStore.get(groupId);

                // Get message count for this group
                db.get('SELECT COUNT(*) as count FROM messages WHERE group_id = ?', [groupId], (err, msgCount) => {
                    if (err) {
                        processed++;
                        if (processed === groupIds.length) {
                            return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                        }
                        return;
                    }

                    // Get event count for this group
                    db.get('SELECT COUNT(*) as count FROM events WHERE group_id = ?', [groupId], (err, eventCount) => {
                        if (err) {
                            processed++;
                            if (processed === groupIds.length) {
                                return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                            }
                            return;
                        }

                        // Get top senders for this group
                        db.all(`
                            SELECT sender as name, COUNT(*) as count
                            FROM messages
                            WHERE group_id = ?
                            GROUP BY sender
                            ORDER BY count DESC
                            LIMIT 5
                        `, [groupId], (err, topSenders) => {
                            if (err) topSenders = [];

                            stats.groups.push({
                                id: groupId,
                                name: groupInfo.name,
                                messageCount: msgCount.count,
                                eventCount: eventCount.count,
                                memberCount: groupInfo.memberCount,
                                topSenders: topSenders || []
                            });

                            processed++;
                            if (processed === groupIds.length) {
                                res.json({
                                    success: true,
                                    stats: stats,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        });
                    });
                });
            });
        });
    });
});

// Add a new group to monitor
app.post('/api/groups', async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Group name is required'
            });
        }

        const groupName = name.trim();

        // Check if WhatsApp client is ready
        if (!isClientReady || !client) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client is not ready. Please wait.'
            });
        }

        // Check if group is already being monitored
        const existingGroup = Array.from(groupInfoStore.values()).find(
            g => g.name.toLowerCase() === groupName.toLowerCase()
        );

        if (existingGroup) {
            return res.status(409).json({
                success: false,
                error: 'Group is already being monitored'
            });
        }

        // Search for the group in WhatsApp
        const chats = await client.getChats();
        const group = chats.find(chat =>
            chat.isGroup && chat.name && chat.name.toLowerCase().includes(groupName.toLowerCase())
        );

        if (!group) {
            return res.status(404).json({
                success: false,
                error: `Group "${groupName}" not found in your WhatsApp chats`
            });
        }

        // Add group to monitoring
        const groupId = group.id._serialized;
        const memberCount = group.participants ? group.participants.length : 0;
        const members = group.participants ? group.participants.map(p => p.id._serialized) : [];

        const groupInfo = {
            id: groupId,
            name: group.name,
            memberCount: memberCount
        };

        groupInfoStore.set(groupId, groupInfo);

        monitoredGroups.set(groupId, {
            name: group.name,
            id: groupId,
            previousMessageIds: new Set(),
            previousMembers: new Set(members),
            isFirstRun: true
        });

        // Update config.json
        const configPath = path.join(__dirname, 'config.json');
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        if (!currentConfig.groups.includes(group.name)) {
            currentConfig.groups.push(group.name);
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
        }

        // Immediately check for messages in this new group
        const groupData = monitoredGroups.get(groupId);
        await checkMessages(groupId, groupData);

        // Broadcast to WebSocket clients
        broadcast({
            type: 'group_added',
            group: groupInfo
        });

        console.log(`✅ Added new group to monitoring: "${group.name}"`);

        res.json({
            success: true,
            message: 'Group added successfully',
            group: groupInfo
        });

    } catch (error) {
        console.error('Error adding group:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add group: ' + error.message
        });
    }
});

// DELETE /api/groups/:groupId - Stop monitoring a group
app.delete('/api/groups/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;

        // Check if group exists in monitored groups
        const groupData = groupInfoStore.get(groupId);
        if (!groupData) {
            return res.status(404).json({
                success: false,
                error: 'Group not found in monitoring list'
            });
        }

        const groupName = groupData.name;

        // Remove from memory stores
        monitoredGroups.delete(groupId);
        groupInfoStore.delete(groupId);

        // Update config.json to remove the group
        const configPath = path.join(__dirname, 'config.json');
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        currentConfig.groups = currentConfig.groups.filter(g => g !== groupName);
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));

        console.log(`🗑️  Stopped monitoring group: "${groupName}"`);

        res.json({
            success: true,
            message: 'Group removed from monitoring',
            groupId: groupId
        });

    } catch (error) {
        console.error('Error deleting group:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to delete group'
        });
    }
});

// ============================================
// WEBSOCKET
// ============================================

wss.on('connection', (ws) => {
    console.log('✅ New WebSocket client connected');
    wsClients.add(ws);

    // Send initial data
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to WhatsApp Analytics',
        groups: Array.from(groupInfoStore.values())
    }));

    ws.on('close', () => {
        console.log('❌ WebSocket client disconnected');
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        wsClients.delete(ws);
    });
});

// Broadcast to all WebSocket clients
function broadcast(data) {
    const message = JSON.stringify(data);
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// WHATSAPP CLIENT INITIALIZATION
// ============================================

// Find Chromium executable on Railway/Nixpacks
function findChromiumExecutable() {
    const { execSync } = require('child_process');

    // Try to find chromium in nix store
    try {
        const chromiumPath = execSync('which chromium || find /nix/store -name chromium -type f 2>/dev/null | head -1', {
            encoding: 'utf8'
        }).trim();

        if (chromiumPath && fs.existsSync(chromiumPath)) {
            console.log('✅ Found Chromium at:', chromiumPath);
            return chromiumPath;
        }
    } catch (e) {
        console.log('⚠️  Could not find chromium via which/find');
    }

    // Return null to use default Puppeteer behavior
    return null;
}

async function initClient() {
    const chromiumPath = findChromiumExecutable();
    const puppeteerConfig = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    };

    // Add executablePath if we found Chromium
    if (chromiumPath) {
        puppeteerConfig.executablePath = chromiumPath;
    }

    // Use persistent storage path for WhatsApp session
    const authPath = path.join(DATA_DIR, '.wwebjs_auth');
    console.log(`🔐 WhatsApp session path: ${authPath}`);

    // Clean up any leftover Chromium lock files from previous crashes
    const lockFile = path.join(authPath, 'session', 'SingletonLock');
    if (fs.existsSync(lockFile)) {
        try {
            fs.unlinkSync(lockFile);
            console.log('🧹 Cleaned up stale Chromium lock file');
        } catch (e) {
            console.log('⚠️  Could not remove stale lock file:', e.message);
        }
    }

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: authPath
        }),
        puppeteer: puppeteerConfig
    });

    client.on('qr', (qr) => {
        console.log('\n📱 Scan this QR code with WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        console.log('\nWaiting for scan...\n');

        currentQRCode = qr;
        authStatus = 'qr_ready';

        // Broadcast QR code to all connected WebSocket clients
        broadcast({
            type: 'qr',
            qr: qr,
            message: 'Scan this QR code with WhatsApp'
        });
    });

    client.on('authenticated', () => {
        console.log('✅ Authenticated!');
        authStatus = 'authenticating';
        currentQRCode = null;

        broadcast({
            type: 'authenticated',
            message: 'WhatsApp authenticated successfully'
        });
    });

    client.on('ready', async () => {
        console.log('✅ WhatsApp client ready!\n');
        isClientReady = true;
        authStatus = 'authenticated';

        broadcast({
            type: 'ready',
            message: 'WhatsApp client ready'
        });

        // Initialize groups
        await initializeGroups();

        if (monitoredGroups.size === 0) {
            console.error('❌ No matching groups found!');
            console.log('Please update config.json with valid group names.\n');
        } else {
            console.log('🔄 Starting monitoring...\n');

            // Start checking immediately and then every interval
            checkAllGroups();
            setInterval(checkAllGroups, CHECK_INTERVAL);
        }
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Auth failed:', msg);
        authStatus = 'failed';

        broadcast({
            type: 'auth_failure',
            message: 'Authentication failed: ' + msg
        });
    });

    client.on('disconnected', (reason) => {
        console.log('⚠️  Disconnected:', reason);
        isClientReady = false;
        broadcast({ type: 'disconnected', message: 'WhatsApp disconnected' });
    });

    // Listen for group participant changes (joins/leaves)
    client.on('group_join', async (notification) => {
        const groupId = notification.chatId._serialized;
        const groupInfo = monitoredGroups.get(groupId);

        if (groupInfo && DETECT_JOINS_LEAVES) {
            for (const participant of notification.recipientIds) {
                const event = await createEvent(participant._serialized, 'JOIN', groupInfo.name, groupId);
                if (event) {
                    // Save event to SQLite
                    const eventDate = event.timestamp.substring(0, 10); // Extract YYYY-MM-DD
                    // Delete previous JOIN events for this member in this group
                    db.run(`
                        DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'JOIN'
                    `, [event.groupId, event.memberId], () => {
                        // Insert new JOIN event
                        db.run(`
                            INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
                    });

                    console.log(`🟢 ${event.memberName} joined ${groupInfo.name}`);
                    broadcast({ type: 'event', event: event });
                }
            }
        }
    });

    client.on('group_leave', async (notification) => {
        const groupId = notification.chatId._serialized;
        const groupInfo = monitoredGroups.get(groupId);

        if (groupInfo && DETECT_JOINS_LEAVES) {
            for (const participant of notification.recipientIds) {
                const event = await createEvent(participant._serialized, 'LEAVE', groupInfo.name, groupId);
                if (event) {
                    // Save event to SQLite
                    const eventDate = event.timestamp.substring(0, 10); // Extract YYYY-MM-DD
                    // Delete previous LEAVE events for this member in this group
                    db.run(`
                        DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'LEAVE'
                    `, [event.groupId, event.memberId], () => {
                        // Insert new LEAVE event
                        db.run(`
                            INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
                    });

                    console.log(`🔴 ${event.memberName} left ${groupInfo.name}`);
                    broadcast({ type: 'event', event: event });
                }
            }
        }
    });

    await client.initialize();
}

async function initializeGroups() {
    const chats = await client.getChats();

    for (const groupName of GROUP_NAMES) {
        const group = chats.find(chat =>
            chat.isGroup && chat.name && chat.name.toLowerCase().includes(groupName.toLowerCase())
        );

        if (group) {
            console.log(`✅ Found group: "${group.name}"`);

            const memberCount = group.participants ? group.participants.length : 0;
            const members = group.participants ? group.participants.map(p => p.id._serialized) : [];

            groupInfoStore.set(group.id._serialized, {
                id: group.id._serialized,
                name: group.name,
                memberCount: memberCount
            });

            monitoredGroups.set(group.id._serialized, {
                name: group.name,
                id: group.id._serialized,
                previousMessageIds: new Set(),
                previousMembers: new Set(members),
                isFirstRun: true
            });
        } else {
            console.log(`❌ Group "${groupName}" not found`);
        }
    }
}

async function checkAllGroups() {
    for (const [groupId, groupInfo] of monitoredGroups) {
        await checkMessages(groupId, groupInfo);
    }
}

async function checkMessages(groupId, groupInfo) {
    const timestamp = new Date().toLocaleString();
    console.log(`[${timestamp}] Checking ${groupInfo.name}...`);

    try {
        const chats = await client.getChats();
        const group = chats.find(chat => chat.id._serialized === groupId);

        if (!group) {
            console.error(`❌ Group ${groupInfo.name} not found`);
            return;
        }

        // Check for member changes
        if (DETECT_JOINS_LEAVES && group.participants) {
            const currentMembers = new Set(group.participants.map(p => p.id._serialized));

            // Detect joins
            for (const memberId of currentMembers) {
                if (!groupInfo.previousMembers.has(memberId) && !groupInfo.isFirstRun) {
                    const event = await createEvent(memberId, 'JOIN', groupInfo.name, groupId);
                    if (event) {
                        const eventDate = event.timestamp.substring(0, 10); // Extract YYYY-MM-DD
                        // Delete previous JOIN events for this member in this group
                        db.run(`
                            DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'JOIN'
                        `, [event.groupId, event.memberId], () => {
                            // Insert new JOIN event
                            db.run(`
                                INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `, [event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
                        });

                        console.log(`🟢 ${event.memberName} joined ${groupInfo.name}`);
                        broadcast({ type: 'event', event: event });
                    }
                }
            }

            // Detect leaves
            for (const memberId of groupInfo.previousMembers) {
                if (!currentMembers.has(memberId) && !groupInfo.isFirstRun) {
                    const event = await createEvent(memberId, 'LEAVE', groupInfo.name, groupId);
                    if (event) {
                        const eventDate = event.timestamp.substring(0, 10); // Extract YYYY-MM-DD
                        // Delete previous LEAVE events for this member in this group
                        db.run(`
                            DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'LEAVE'
                        `, [event.groupId, event.memberId], () => {
                            // Insert new LEAVE event
                            db.run(`
                                INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `, [event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
                        });

                        console.log(`🔴 ${event.memberName} left ${groupInfo.name}`);
                        broadcast({ type: 'event', event: event });
                    }
                }
            }

            // Update member count
            const groupData = groupInfoStore.get(groupId);
            if (groupData) {
                groupData.memberCount = currentMembers.size;
                groupInfoStore.set(groupId, groupData);
            }

            groupInfo.previousMembers = currentMembers;
        }

        const messages = await group.fetchMessages({ limit: MESSAGE_LIMIT });

        // Detect new messages
        const newMessages = [];
        for (const msg of messages) {
            const msgId = msg.id._serialized;
            if (!groupInfo.previousMessageIds.has(msgId)) {
                newMessages.push(msg);
                groupInfo.previousMessageIds.add(msgId);
            }
        }

        if (newMessages.length > 0 || groupInfo.isFirstRun) {
            const processedMessages = [];

            for (const msg of messages) {
                const processed = await processMessage(msg, groupInfo.name, groupId);
                if (processed) {
                    processedMessages.push(processed);
                }
            }

            // Save messages to SQLite database
            const insertStmt = db.prepare(`
                INSERT OR REPLACE INTO messages (id, group_id, group_name, sender, sender_id, message, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const msg of processedMessages) {
                insertStmt.run(msg.id, msg.groupId, msg.groupName, msg.sender, msg.senderId, msg.message, msg.timestamp);
            }

            insertStmt.finalize();

            if (!groupInfo.isFirstRun) {
                console.log(`🆕 ${newMessages.length} new message(s) in ${groupInfo.name}`);

                // Broadcast new messages to WebSocket clients
                for (const msg of newMessages) {
                    const processed = await processMessage(msg, groupInfo.name, groupId);
                    if (processed) {
                        broadcast({ type: 'message', message: processed });
                    }
                }
            } else {
                console.log(`✅ Loaded ${processedMessages.length} messages from ${groupInfo.name}`);
            }

            groupInfo.isFirstRun = false;
        } else {
            console.log(`   No new messages in ${groupInfo.name}`);
        }

        // Clean up old message IDs
        if (groupInfo.previousMessageIds.size > 100) {
            const idsArray = Array.from(groupInfo.previousMessageIds);
            groupInfo.previousMessageIds = new Set(idsArray.slice(-100));
        }

    } catch (error) {
        console.error(`❌ Error checking ${groupInfo.name}:`, error.message);
    }
}

async function processMessage(msg, groupName, groupId) {
    try {
        const timestamp = new Date(msg.timestamp * 1000);

        // Handle notification messages (joins, leaves, etc.)
        if (msg.type === 'notification' || msg.type === 'notification_template' || msg.type === 'group_notification') {
            // Extract notification details - use body as default message
            let notificationMessage = msg.body || 'Group notification';
            let eventType = null;
            let memberId = null;
            let memberName = 'Unknown';

            // Log the notification for debugging
            console.log('📋 Notification details:', {
                type: msg.type,
                subtype: msg.subtype,
                body: msg.body,
                recipientIds: msg.recipientIds,
                author: msg.author
            });

            // Try to detect if it's a join or leave event
            if (msg.recipientIds && msg.recipientIds.length > 0) {
                memberId = msg.recipientIds[0];

                // Get member name and phone
                try {
                    const contact = await client.getContactById(memberId);
                    const memberPhone = contact.number || memberId.split('@')[0];
                    memberName = contact.pushname || contact.name || memberPhone;
                } catch (e) {
                    memberName = memberId.split('@')[0];
                }

                // Determine if it's a join or leave based on notification subtype
                if (msg.subtype === 'add' || msg.subtype === 'invite' || msg.subtype === 'group_invite_link') {
                    eventType = 'JOIN';
                    // Use body if available, otherwise construct message
                    if (!msg.body || msg.body.trim() === '') {
                        if (msg.subtype === 'group_invite_link') {
                            notificationMessage = `${memberName} joined via group link`;
                        } else {
                            notificationMessage = `${memberName} joined`;
                        }
                    }
                } else if (msg.subtype === 'remove' || msg.subtype === 'leave') {
                    eventType = 'LEAVE';
                    // Use body if available, otherwise construct message
                    if (!msg.body || msg.body.trim() === '') {
                        notificationMessage = `${memberName} left`;
                    }
                }

                // Save to events table if we detected the event type
                if (eventType && memberId) {
                    const timestampISO = timestamp.toISOString();
                    const eventDate = timestampISO.substring(0, 10); // Extract YYYY-MM-DD

                    // Delete previous events of the same type for this member in this group
                    db.run(`
                        DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = ?
                    `, [groupId, memberId, eventType], () => {
                        // Insert new event
                        db.run(`
                            INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `, [groupId, groupName, memberId, memberName, eventType, timestampISO, eventDate]);

                        console.log(`📝 Detected ${eventType} event from history: ${memberName} in ${groupName}`);

                        // Broadcast the event via WebSocket
                        broadcast({
                            type: 'event',
                            event: {
                                groupId: groupId,
                                groupName: groupName,
                                memberId: memberId,
                                memberName: memberName,
                                type: eventType,
                                timestamp: timestampISO
                            }
                        });
                    });
                }
            }

            // Return the notification as a message for display in chat
            return {
                id: msg.id._serialized,
                timestamp: timestamp.toISOString(),
                sender: 'System',
                senderId: '',
                message: notificationMessage || 'Group notification',
                type: msg.type,
                hasMedia: false,
                groupId: groupId,
                groupName: groupName
            };
        }

        // Handle regular messages
        let senderName = 'Unknown';
        let senderId = msg.author || '';
        let senderPhone = '';

        if (msg.author) {
            try {
                const contact = await client.getContactById(msg.author);
                // Get the actual phone number from contact object (most reliable)
                senderPhone = contact.number || msg.author.split('@')[0];
                // Get display name (prefer pushname, then name, then phone number)
                senderName = contact.pushname || contact.name || senderPhone;
            } catch (e) {
                // Fallback: extract phone from WhatsApp ID (format: 1234567890@c.us)
                senderPhone = msg.author.split('@')[0];
                senderName = senderPhone;
            }
        }

        // Detect voice recordings (audio/ptt) and save as CERTIFICATE event
        if (msg.type === 'ptt' || msg.type === 'audio') {
            const timestampISO = timestamp.toISOString();
            const eventDate = timestampISO.substring(0, 10); // YYYY-MM-DD

            // Delete previous CERTIFICATE event for this member on this date
            db.run(`
                DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'CERTIFICATE' AND date = ?
            `, [groupId, senderId, eventDate], () => {
                // Insert new CERTIFICATE event
                db.run(`
                    INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [groupId, groupName, senderId, senderName, 'CERTIFICATE', timestampISO, eventDate]);

                console.log(`📜 Certificate recorded: ${senderName} in ${groupName} on ${eventDate}`);

                // Broadcast certificate event
                broadcast({
                    type: 'event',
                    event: {
                        groupId: groupId,
                        groupName: groupName,
                        memberId: senderId,
                        memberName: senderName,
                        type: 'CERTIFICATE',
                        timestamp: timestampISO
                    }
                });
            });
        }

        let body = msg.body || '';
        if (msg.hasMedia) {
            body = body || `<${msg.type}>`;
        }

        // Format sender with phone number if available
        let senderDisplay = senderName;
        if (senderPhone && senderName !== senderPhone) {
            senderDisplay = `${senderName} (${senderPhone})`;
        } else if (senderPhone) {
            senderDisplay = senderPhone;
        }

        return {
            id: msg.id._serialized,
            timestamp: timestamp.toISOString(),
            sender: senderDisplay,
            senderId: msg.author || '',
            message: body,
            type: msg.type,
            hasMedia: msg.hasMedia,
            groupId: groupId,
            groupName: groupName
        };
    } catch (error) {
        return null;
    }
}

async function createEvent(memberId, eventType, groupName, groupId) {
    try {
        const contact = await client.getContactById(memberId);
        const memberName = contact.pushname || contact.name || contact.number || 'Unknown';

        return {
            timestamp: new Date().toISOString(),
            type: eventType,
            memberName: memberName,
            memberId: memberId,
            groupId: groupId,
            groupName: groupName
        };
    } catch (e) {
        return {
            timestamp: new Date().toISOString(),
            type: eventType,
            memberName: 'Unknown',
            memberId: memberId,
            groupId: groupId,
            groupName: groupName
        };
    }
}

// ============================================
// FRONTEND ROUTING (Catch-all for SPA)
// ============================================
// Serve index.html for all non-API routes in production
if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    app.get('*', (req, res) => {
        const indexPath = path.join(__dirname, 'frontend', 'dist', 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.status(404).json({ error: 'Frontend not built. Run npm run build first.' });
        }
    });
}

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    console.log(`\n🚀 API Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket available at ws://localhost:${PORT}`);
    console.log('\nAPI Endpoints:');
    console.log(`  GET  /api/health - Server health check`);
    console.log(`  GET  /api/groups - List monitored groups`);
    console.log(`  GET  /api/groups/:groupId/members - Get all members of a group`);
    console.log(`  GET  /api/messages - Get all messages (paginated)`);
    console.log(`  GET  /api/messages/:groupId - Get messages from specific group`);
    console.log(`  GET  /api/events - Get all join/leave events`);
    console.log(`  GET  /api/events/:groupId - Get events from specific group`);
    console.log(`  GET  /api/search?q=query - Search messages`);
    console.log(`  GET  /api/stats - Get statistics\n`);

    // Initialize WhatsApp client
    initClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    if (client) {
        await client.destroy();
    }
    server.close();
    console.log('✅ Goodbye!\n');
    process.exit(0);
});
