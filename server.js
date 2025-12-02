const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { translate } = require('@vitalets/google-translate-api');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Configuration will be loaded from DATA_DIR below
let config;

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

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '1d'; // Token expires in 1 day

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Access token required'
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        req.user = user; // { userId, username, email }
        next();
    });
}

// Config file path - use volume in production for persistence
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Load config from persistent location (NEVER overwrite existing volume config)
try {
    const configFile = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(configFile);
    console.log(`📋 Loaded config from: ${CONFIG_PATH}`);
    console.log(`📋 Groups loaded: ${config.groups.join(', ') || '(none)'}`);
} catch (error) {
    // Config doesn't exist in volume, create default
    console.log('📋 No config found in volume, creating default...');
    config = {
        groups: [],  // Start with empty array - user will add groups via UI
        checkInterval: 60000,
        messageLimit: 15,
        detectJoinsLeaves: true,
        port: 3000
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`📋 Created new config at: ${CONFIG_PATH}`);
}

// Extract configuration values AFTER loading from volume
const PORT = process.env.PORT || config.port || 3000;
const CHECK_INTERVAL = config.checkInterval || 60000;
const MESSAGE_LIMIT = config.messageLimit || 15;
const DETECT_JOINS_LEAVES = config.detectJoinsLeaves !== false;
const GROUP_NAMES = config.groups || [];

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
        // Users table (for multi-tenant support)
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // WhatsApp sessions table (maps users to their WhatsApp clients)
        db.run(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                session_id TEXT UNIQUE NOT NULL,
                phone_number TEXT,
                is_authenticated BOOLEAN DEFAULT 0,
                last_connected DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Messages table
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                group_id TEXT NOT NULL,
                group_name TEXT NOT NULL,
                sender TEXT NOT NULL,
                sender_id TEXT,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Events table
        db.run(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                group_id TEXT NOT NULL,
                group_name TEXT NOT NULL,
                member_id TEXT NOT NULL,
                member_name TEXT NOT NULL,
                type TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                date TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Monitored groups table (stores which groups each user is monitoring)
        db.run(`
            CREATE TABLE IF NOT EXISTS monitored_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_id TEXT NOT NULL,
                group_name TEXT NOT NULL,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, group_id)
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

        // Add user_id column to existing messages table if it doesn't exist
        db.run(`
            ALTER TABLE messages ADD COLUMN user_id INTEGER
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding user_id column to messages:', err);
            } else if (!err) {
                console.log('✅ Added user_id column to messages table');
            }
        });

        // Add user_id column to existing events table if it doesn't exist
        db.run(`
            ALTER TABLE events ADD COLUMN user_id INTEGER
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding user_id column to events:', err);
            } else if (!err) {
                console.log('✅ Added user_id column to events table');
            }
        });

        // Create indexes for better query performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id ON whatsapp_sessions(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_session_id ON whatsapp_sessions(session_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_group_id ON events(group_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_date_member ON events(date, member_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_monitored_groups_user_id ON monitored_groups(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_monitored_groups_group_id ON monitored_groups(group_id)`);

        console.log('✅ Database tables initialized');
    });
}

// In-memory storage for group info (lightweight, doesn't need persistence)
const groupInfoStore = new Map(); // groupId -> { name, id, memberCount }

// In-memory cache for group members: groupId -> Map(memberId -> {name, phone, isAdmin})
const groupMembersCache = new Map();

// WebSocket clients
const wsClients = new Set();

// ============================================
// MULTI-CLIENT WHATSAPP MANAGEMENT
// ============================================

// Map of WhatsApp clients per user: userId -> WhatsAppClient
const whatsappClients = new Map();

// Map of monitored groups per user: userId -> Map(groupId -> groupInfo)
const userMonitoredGroups = new Map();

// Map of client ready status per user: userId -> boolean
const userClientReady = new Map();

// Map of QR codes per user: userId -> qrCodeString
const userQRCodes = new Map();

// Map of authentication status per user: userId -> status
const userAuthStatus = new Map();

// Legacy single-client variables (for backward compatibility during migration)
let client; // Will be deprecated
let monitoredGroups = new Map(); // Will be deprecated
let isClientReady = false; // Will be deprecated
let currentQRCode = null; // Will be deprecated
let authStatus = 'initializing'; // Will be deprecated

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

// ============================================
// USER AUTHENTICATION ENDPOINTS
// ============================================

// User Registration
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validation
        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Username, email, and password are required'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'Password must be at least 6 characters long'
            });
        }

        // Check if user already exists
        db.get('SELECT id FROM users WHERE email = ? OR username = ?', [email, username], async (err, existingUser) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Database error'
                });
            }

            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    error: 'Username or email already exists'
                });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Create user
            db.run(
                'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
                [username, email, passwordHash],
                function(err) {
                    if (err) {
                        console.error('Error creating user:', err);
                        return res.status(500).json({
                            success: false,
                            error: 'Failed to create user'
                        });
                    }

                    const userId = this.lastID;

                    // Generate JWT token
                    const token = jwt.sign(
                        { userId, username, email },
                        JWT_SECRET,
                        { expiresIn: JWT_EXPIRES_IN }
                    );

                    console.log(`✅ User registered: ${username} (${email})`);

                    res.status(201).json({
                        success: true,
                        token,
                        user: {
                            id: userId,
                            username,
                            email
                        }
                    });
                }
            );
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            error: 'Registration failed'
        });
    }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }

        // Find user
        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Database error'
                });
            }

            if (!user) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid email or password'
                });
            }

            // Verify password
            const isValidPassword = await bcrypt.compare(password, user.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid email or password'
                });
            }

            // Generate JWT token
            const token = jwt.sign(
                { userId: user.id, username: user.username, email: user.email },
                JWT_SECRET,
                { expiresIn: JWT_EXPIRES_IN }
            );

            console.log(`✅ User logged in: ${user.username} (${user.email})`);

            res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed'
        });
    }
});

// Verify Token (check if user is authenticated)
app.get('/api/auth/me', authenticateToken, (req, res) => {
    db.get('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.user.userId], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                createdAt: user.created_at
            }
        });
    });
});

// ============================================
// PER-USER WHATSAPP ENDPOINTS (Multi-tenant)
// ============================================
// Note: Old single-client endpoints removed.
// Use /api/whatsapp/* endpoints instead.

// Initialize WhatsApp client for logged-in user
app.post('/api/whatsapp/init', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Check if session record exists, create if not
        db.get('SELECT * FROM whatsapp_sessions WHERE user_id = ?', [userId], async (err, session) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Database error'
                });
            }

            // Create session record if it doesn't exist
            if (!session) {
                db.run(
                    'INSERT INTO whatsapp_sessions (user_id, session_id, is_authenticated) VALUES (?, ?, ?)',
                    [userId, `session_${userId}_${Date.now()}`, 0],
                    (err) => {
                        if (err) {
                            console.error('Error creating session:', err);
                        }
                    }
                );
            }

            // Initialize WhatsApp client for this user
            try {
                await initClientForUser(userId);

                res.json({
                    success: true,
                    message: 'WhatsApp client initialization started',
                    userId: userId
                });
            } catch (error) {
                console.error(`Error initializing client for user ${userId}:`, error);
                res.status(500).json({
                    success: false,
                    error: 'Failed to initialize WhatsApp client'
                });
            }
        });
    } catch (error) {
        console.error('Error in /api/whatsapp/init:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get QR code for logged-in user
app.get('/api/whatsapp/qr', authenticateToken, (req, res) => {
    const userId = req.user.userId;

    // Check if client is ready
    if (userClientReady.get(userId)) {
        return res.json({
            success: true,
            authenticated: true,
            message: 'WhatsApp already authenticated'
        });
    }

    // Check for QR code
    const qrCode = userQRCodes.get(userId);
    const authStatus = userAuthStatus.get(userId) || 'not_initialized';

    if (!qrCode) {
        return res.json({
            success: false,
            authenticated: false,
            qr: null,
            authStatus: authStatus,
            message: authStatus === 'not_initialized'
                ? 'Please initialize WhatsApp client first'
                : 'QR code not yet generated. Please wait...'
        });
    }

    res.json({
        success: true,
        authenticated: false,
        qr: qrCode,
        authStatus: authStatus,
        message: 'Scan this QR code with WhatsApp'
    });
});

// Get WhatsApp status for logged-in user
app.get('/api/whatsapp/status', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    // Check if client is already in memory
    if (userClientReady.get(userId)) {
        return res.json({
            success: true,
            authenticated: true,
            authStatus: 'authenticated',
            hasQR: false,
            timestamp: new Date().toISOString()
        });
    }

    // Check if session files exist on disk (from previous session)
    const sessionPath = path.join(DATA_DIR, '.wwebjs_auth', `user_${userId}`);
    const sessionExists = fs.existsSync(sessionPath);

    if (sessionExists && !whatsappClients.has(userId)) {
        // Session exists but client not initialized - auto-restore it
        console.log(`🔄 Auto-restoring WhatsApp session for user ${userId}...`);

        try {
            // Initialize client in background (don't wait for it)
            initClientForUser(userId).catch(err => {
                console.error(`Failed to auto-restore session for user ${userId}:`, err);
            });

            return res.json({
                success: true,
                authenticated: false,
                authStatus: 'restoring',
                hasQR: false,
                message: 'Restoring previous session...',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`Error auto-restoring session for user ${userId}:`, error);
        }
    }

    // No session files, needs to scan QR
    res.json({
        success: true,
        authenticated: false,
        authStatus: userAuthStatus.get(userId) || 'not_initialized',
        hasQR: userQRCodes.has(userId),
        timestamp: new Date().toISOString()
    });
});

// Disconnect WhatsApp (but keep account logged in)
app.post('/api/whatsapp/logout', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        console.log(`🚪 Disconnecting WhatsApp for user ${userId}...`);

        // Get the client
        const userClient = whatsappClients.get(userId);

        if (userClient) {
            // Destroy the client
            await userClient.destroy();
            console.log(`✓ WhatsApp client destroyed for user ${userId}`);
        }

        // Remove from maps
        whatsappClients.delete(userId);
        userClientReady.delete(userId);
        userQRCodes.delete(userId);
        userAuthStatus.delete(userId);
        userMonitoredGroups.delete(userId);

        // Delete session files
        const sessionPath = path.join(DATA_DIR, '.wwebjs_auth', `user_${userId}`);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`✓ Session files deleted for user ${userId}`);
            } catch (error) {
                console.error(`Error deleting session files for user ${userId}:`, error);
            }
        }

        // Update database
        db.run(`
            UPDATE whatsapp_sessions
            SET is_authenticated = 0, phone_number = NULL
            WHERE user_id = ?
        `, [userId]);

        res.json({
            success: true,
            message: 'WhatsApp disconnected successfully (account still logged in)'
        });
    } catch (error) {
        console.error('Error during WhatsApp logout:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to disconnect WhatsApp'
        });
    }
});

// Get all groups being monitored
app.get('/api/groups', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const userGroups = userMonitoredGroups.get(userId);

    if (!userGroups) {
        return res.json({
            success: true,
            groups: [],
            count: 0
        });
    }

    const groups = Array.from(userGroups.values()).map(g => ({
        id: g.id,
        name: g.name,
        memberCount: g.previousMembers ? g.previousMembers.size : 0
    }));

    res.json({
        success: true,
        groups: groups,
        count: groups.length
    });
});

// Get all members of a specific group with their phone numbers
app.get('/api/groups/:groupId/members', authenticateToken, async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const userId = req.user.userId;

        const userClient = whatsappClients.get(userId);
        if (!userClient || !userClientReady.get(userId)) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client not ready'
            });
        }

        // Get the group chat
        const chat = await userClient.getChatById(groupId);

        if (!chat.isGroup) {
            return res.status(400).json({
                success: false,
                error: 'Chat is not a group'
            });
        }

        // Get all participants
        const participants = chat.participants;

        // Create a Map for this group's members cache
        const membersMap = new Map();

        // Fetch contact details for each participant
        const members = await Promise.all(
            participants.map(async (participant) => {
                try {
                    const contact = await userClient.getContactById(participant.id._serialized);
                    const phone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || participant.id.user);
                    const name = contact.pushname || contact.name || contact.verifiedName || phone;

                    const memberData = {
                        id: participant.id._serialized,
                        phone: phone,
                        name: name,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };

                    // Cache this member by their ID
                    membersMap.set(participant.id._serialized, {
                        name: name,
                        phone: phone,
                        isAdmin: participant.isAdmin
                    });

                    return memberData;
                } catch (error) {
                    // Fallback if contact fetch fails
                    const phone = participant.id.user;
                    const memberData = {
                        id: participant.id._serialized,
                        phone: phone,
                        name: phone,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };

                    // Cache this member
                    membersMap.set(participant.id._serialized, {
                        name: phone,
                        phone: phone,
                        isAdmin: participant.isAdmin
                    });

                    return memberData;
                }
            })
        );

        // Store the members map in cache
        groupMembersCache.set(groupId, membersMap);
        console.log(`✅ Cached ${membersMap.size} members for group ${groupId}`);

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
app.get('/api/messages', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Get total count for this user
    db.get('SELECT COUNT(*) as total FROM messages WHERE user_id = ?', [userId], (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated messages for this user (sorted by timestamp DESC - newest first)
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE user_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [userId, limit, offset], (err, rows) => {
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
app.get('/api/messages/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const groupId = req.params.groupId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const userGroups = userMonitoredGroups.get(userId);
    const groupInfo = userGroups?.get(groupId);

    // Get total count for this group and user
    db.get('SELECT COUNT(*) as total FROM messages WHERE group_id = ? AND user_id = ?', [groupId, userId], (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated messages for this group and user
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE group_id = ? AND user_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [groupId, userId, limit, offset], (err, rows) => {
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
app.get('/api/events', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const date = req.query.date; // Optional: filter by specific date (YYYY-MM-DD) or date range (YYYY-MM-DD,YYYY-MM-DD)
    const memberId = req.query.memberId; // Optional: filter by member phone number

    // Build WHERE clause dynamically
    let whereConditions = ['user_id = ?'];
    let params = [userId];

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

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

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
app.get('/api/events/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const groupId = req.params.groupId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const userGroups = userMonitoredGroups.get(userId);
    const groupInfo = userGroups?.get(groupId);

    // Get total count for this group and user
    db.get('SELECT COUNT(*) as total FROM events WHERE group_id = ? AND user_id = ?', [groupId, userId], (err, countRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated events for this group and user
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, member_id as memberId,
                   member_name as memberName, type, timestamp, date
            FROM events
            WHERE group_id = ? AND user_id = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [groupId, userId, limit, offset], (err, rows) => {
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
app.get('/api/search', authenticateToken, (req, res) => {
    const userId = req.user.userId;
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
        // Search in specific group for this user
        sqlQuery = `
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE user_id = ? AND group_id = ? AND (message LIKE ? OR sender LIKE ?)
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        params = [userId, groupId, searchPattern, searchPattern, limit];
    } else {
        // Search in all user's groups
        sqlQuery = `
            SELECT id, group_id as groupId, group_name as groupName, sender, sender_id as senderId, message, timestamp
            FROM messages
            WHERE user_id = ? AND (message LIKE ? OR sender LIKE ?)
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        params = [userId, searchPattern, searchPattern, limit];
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

// Translate single message (Arabic to Chinese)
app.post('/api/translate-message', async (req, res) => {
    try {
        const { messageId, text } = req.body;

        if (!text) {
            return res.status(400).json({
                success: false,
                error: 'Text is required'
            });
        }

        console.log(`🔄 Translating message ${messageId}: ${text.substring(0, 50)}...`);

        // Translate from Arabic to Simplified Chinese
        const result = await translate(text, { from: 'ar', to: 'zh-CN' });

        console.log(`✅ Translation complete: ${result.text.substring(0, 50)}...`);

        res.json({
            success: true,
            messageId: messageId,
            original: text,
            translated: result.text
        });
    } catch (error) {
        console.error('Translation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get statistics
app.get('/api/stats', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const stats = {
        groups: [],
        totalMessages: 0,
        totalEvents: 0
    };

    // Get total counts for this user
    db.get('SELECT COUNT(*) as total FROM messages WHERE user_id = ?', [userId], (err, msgCountRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        db.get('SELECT COUNT(*) as total FROM events WHERE user_id = ?', [userId], (err, eventCountRow) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            stats.totalMessages = msgCountRow.total;
            stats.totalEvents = eventCountRow.total;

            // Get user's groups
            const userGroups = userMonitoredGroups.get(userId);
            if (!userGroups || userGroups.size === 0) {
                return res.json({
                    success: true,
                    stats: stats,
                    timestamp: new Date().toISOString()
                });
            }

            const groupIds = Array.from(userGroups.keys());
            let processed = 0;

            groupIds.forEach(groupId => {
                const groupInfo = userGroups.get(groupId);

                // Get message count for this group and user
                db.get('SELECT COUNT(*) as count FROM messages WHERE group_id = ? AND user_id = ?', [groupId, userId], (err, msgCount) => {
                    if (err) {
                        processed++;
                        if (processed === groupIds.length) {
                            return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                        }
                        return;
                    }

                    // Get event count for this group and user
                    db.get('SELECT COUNT(*) as count FROM events WHERE group_id = ? AND user_id = ?', [groupId, userId], (err, eventCount) => {
                        if (err) {
                            processed++;
                            if (processed === groupIds.length) {
                                return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                            }
                            return;
                        }

                        // Get top senders for this group and user
                        db.all(`
                            SELECT sender as name, COUNT(*) as count
                            FROM messages
                            WHERE group_id = ? AND user_id = ?
                            GROUP BY sender
                            ORDER BY count DESC
                            LIMIT 5
                        `, [groupId, userId], (err, topSenders) => {
                            if (err) topSenders = [];

                            stats.groups.push({
                                id: groupId,
                                name: groupInfo.name,
                                messageCount: msgCount.count,
                                eventCount: eventCount.count,
                                memberCount: groupInfo.previousMembers ? groupInfo.previousMembers.size : 0,
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
app.post('/api/groups', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.userId;

        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
                success: false,
                error: 'Group name is required'
            });
        }

        const groupName = name.trim();

        // Check if user's WhatsApp client is ready
        const userClient = whatsappClients.get(userId);
        const isReady = userClientReady.get(userId);

        if (!isReady || !userClient) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client is not ready. Please connect WhatsApp first.'
            });
        }

        // Get user's monitored groups
        const userGroups = userMonitoredGroups.get(userId);
        if (!userGroups) {
            userMonitoredGroups.set(userId, new Map());
        }

        // Check if group is already being monitored by this user
        const existingGroup = Array.from(userGroups.values()).find(
            g => g.name.toLowerCase() === groupName.toLowerCase()
        );

        if (existingGroup) {
            return res.status(409).json({
                success: false,
                error: 'Group is already being monitored'
            });
        }

        // Search for the group in user's WhatsApp
        const chats = await userClient.getChats();
        const group = chats.find(chat =>
            chat.isGroup && chat.name && chat.name.toLowerCase().includes(groupName.toLowerCase())
        );

        if (!group) {
            return res.status(404).json({
                success: false,
                error: `Group "${groupName}" not found in your WhatsApp chats`
            });
        }

        // Add group to user's monitoring
        const groupId = group.id._serialized;
        const memberCount = group.participants ? group.participants.length : 0;
        const members = group.participants ? group.participants.map(p => p.id._serialized) : [];

        const groupInfo = {
            id: groupId,
            name: group.name,
            memberCount: memberCount
        };

        userMonitoredGroups.get(userId).set(groupId, {
            name: group.name,
            id: groupId,
            previousMessageIds: new Set(),
            previousMembers: new Set(members),
            isFirstRun: true
        });

        // Save group to database for persistence
        db.run(`
            INSERT OR IGNORE INTO monitored_groups (user_id, group_id, group_name)
            VALUES (?, ?, ?)
        `, [userId, groupId, group.name], (err) => {
            if (err) {
                console.error(`Error saving group to database:`, err);
            } else {
                console.log(`✅ User ${userId} added group "${group.name}" to monitoring (saved to database)`);
            }
        });

        // Immediately check messages for this new group
        const groupData = userMonitoredGroups.get(userId).get(groupId);
        await checkMessagesInGroup(userId, userClient, groupId, groupData);

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
app.delete('/api/groups/:groupId', authenticateToken, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.userId;

        const userGroups = userMonitoredGroups.get(userId);
        if (!userGroups) {
            return res.status(404).json({
                success: false,
                error: 'No groups being monitored'
            });
        }

        // Check if group exists in user's monitored groups
        const groupData = userGroups.get(groupId);
        if (!groupData) {
            return res.status(404).json({
                success: false,
                error: 'Group not found in monitoring list'
            });
        }

        const groupName = groupData.name;

        // Remove from user's memory stores
        userGroups.delete(groupId);

        // Remove from database
        db.run(`
            DELETE FROM monitored_groups
            WHERE user_id = ? AND group_id = ?
        `, [userId, groupId], (err) => {
            if (err) {
                console.error(`Error removing group from database:`, err);
            } else {
                console.log(`🗑️  User ${userId} stopped monitoring group: "${groupName}" (removed from database)`);
            }
        });

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

// ============================================
// PER-USER CLIENT INITIALIZATION
// ============================================

async function initClientForUser(userId) {
    console.log(`\n🔧 Initializing WhatsApp client for user ${userId}...`);

    // Check if client already exists for this user
    if (whatsappClients.has(userId)) {
        console.log(`⚠️  Client already exists for user ${userId}`);
        return whatsappClients.get(userId);
    }

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

    // Use per-user session folder
    const authPath = path.join(DATA_DIR, '.wwebjs_auth', `user_${userId}`);
    console.log(`🔐 WhatsApp session path for user ${userId}: ${authPath}`);

    // Ensure the directory exists
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    // Clean up any leftover Chromium lock files from previous crashes
    const lockFile = path.join(authPath, 'session', 'SingletonLock');
    if (fs.existsSync(lockFile)) {
        try {
            fs.unlinkSync(lockFile);
            console.log(`🧹 Cleaned up stale Chromium lock file for user ${userId}`);
        } catch (e) {
            console.log(`⚠️  Could not remove stale lock file for user ${userId}:`, e.message);
        }
    }

    const userClient = new Client({
        authStrategy: new LocalAuth({
            dataPath: authPath,
            clientId: `user_${userId}` // Unique ID per user
        }),
        puppeteer: puppeteerConfig
    });

    // Initialize storage for this user
    userMonitoredGroups.set(userId, new Map());
    userClientReady.set(userId, false);
    userAuthStatus.set(userId, 'initializing');

    userClient.on('qr', (qr) => {
        console.log(`\n📱 QR code generated for user ${userId}\n`);

        userQRCodes.set(userId, qr);
        userAuthStatus.set(userId, 'qr_ready');

        // Broadcast QR code to user's WebSocket connections
        broadcast({
            type: 'qr',
            userId: userId,
            qr: qr,
            message: `Scan this QR code with WhatsApp (User ${userId})`
        });
    });

    userClient.on('authenticated', () => {
        console.log(`✅ User ${userId} authenticated!`);
        userAuthStatus.set(userId, 'authenticating');
        userQRCodes.delete(userId);

        // Update database
        db.run(`
            UPDATE whatsapp_sessions
            SET is_authenticated = 1, last_connected = datetime('now')
            WHERE user_id = ?
        `, [userId]);

        broadcast({
            type: 'authenticated',
            userId: userId,
            message: 'WhatsApp authenticated successfully'
        });
    });

    userClient.on('ready', async () => {
        console.log(`✅ WhatsApp client ready for user ${userId}!\n`);
        userClientReady.set(userId, true);
        userAuthStatus.set(userId, 'authenticated');

        broadcast({
            type: 'ready',
            userId: userId,
            message: 'WhatsApp client ready'
        });

        // Get user's phone number and update database
        try {
            const phoneInfo = await userClient.info;
            const phoneNumber = phoneInfo.wid.user;

            db.run(`
                UPDATE whatsapp_sessions
                SET phone_number = ?, is_authenticated = 1, last_connected = datetime('now')
                WHERE user_id = ?
            `, [phoneNumber, userId]);
        } catch (error) {
            console.error(`Error getting phone number for user ${userId}:`, error);
        }

        // Initialize groups for this user
        await initializeGroupsForUser(userId, userClient);

        const userGroups = userMonitoredGroups.get(userId);
        if (userGroups && userGroups.size === 0) {
            console.log(`⚠️  No groups configured for user ${userId}`);
        } else {
            console.log(`🔄 Starting monitoring for user ${userId}...\n`);
            // Start monitoring loop for this user
            startMonitoringForUser(userId, userClient);
        }
    });

    userClient.on('auth_failure', (msg) => {
        console.error(`❌ Auth failed for user ${userId}:`, msg);
        userAuthStatus.set(userId, 'failed');

        broadcast({
            type: 'auth_failure',
            userId: userId,
            message: 'Authentication failed: ' + msg
        });
    });

    userClient.on('disconnected', (reason) => {
        console.log(`⚠️  User ${userId} disconnected:`, reason);
        userClientReady.set(userId, false);
        userAuthStatus.set(userId, 'disconnected');

        // Update database
        db.run(`
            UPDATE whatsapp_sessions
            SET is_authenticated = 0
            WHERE user_id = ?
        `, [userId]);

        broadcast({
            type: 'disconnected',
            userId: userId,
            message: 'WhatsApp disconnected. Please scan QR code again.'
        });
    });

    // Store the client
    whatsappClients.set(userId, userClient);

    // Initialize the client
    await userClient.initialize();

    return userClient;
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

            // Cache group members for message author resolution
            await cacheGroupMembers(group.id._serialized);
        } else {
            console.log(`❌ Group "${groupName}" not found`);
        }
    }
}

// Per-user group initialization - Load groups from database
async function initializeGroupsForUser(userId, userClient) {
    console.log(`🔄 Initializing groups for user ${userId}...`);

    try {
        // Load user's monitored groups from database
        const savedGroups = await new Promise((resolve, reject) => {
            db.all(`
                SELECT group_id, group_name
                FROM monitored_groups
                WHERE user_id = ?
                ORDER BY added_at DESC
            `, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        console.log(`📋 Found ${savedGroups.length} saved group(s) for user ${userId} in database`);

        if (savedGroups.length === 0) {
            console.log(`⚠️  No groups configured for user ${userId}. User can add groups via UI.`);
            return;
        }

        // Get all chats from WhatsApp
        const chats = await userClient.getChats();

        // Initialize each saved group
        for (const savedGroup of savedGroups) {
            const groupId = savedGroup.group_id;
            const groupName = savedGroup.group_name;

            // Find the group chat in WhatsApp
            const group = chats.find(chat => chat.id._serialized === groupId);

            if (group) {
                console.log(`✅ Restored group for user ${userId}: "${group.name}"`);

                const memberCount = group.participants ? group.participants.length : 0;
                const members = group.participants ? group.participants.map(p => p.id._serialized) : [];

                // Store in per-user monitored groups
                const userGroups = userMonitoredGroups.get(userId);
                userGroups.set(groupId, {
                    name: group.name,
                    id: groupId,
                    previousMessageIds: new Set(),
                    previousMembers: new Set(members),
                    isFirstRun: true
                });

                // Cache group members for this user
                await cacheGroupMembersForUser(userId, groupId, userClient);
            } else {
                console.log(`⚠️  Group "${groupName}" (${groupId}) not found in WhatsApp chats for user ${userId}. May have been removed.`);
            }
        }

        const userGroups = userMonitoredGroups.get(userId);
        console.log(`✅ User ${userId} now monitoring ${userGroups.size} group(s)`);
    } catch (error) {
        console.error(`Error initializing groups for user ${userId}:`, error);
    }
}

// Function to cache group members for fast lookup
async function cacheGroupMembers(groupId) {
    try {
        console.log(`🔄 Caching members for group ${groupId}...`);

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup || !chat.participants) {
            console.log(`⚠️ Not a group or no participants`);
            return;
        }

        const membersMap = new Map();

        // Process each participant
        for (const participant of chat.participants) {
            try {
                const contact = await client.getContactById(participant.id._serialized);
                const phone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || participant.id.user);
                const name = contact.pushname || contact.name || contact.verifiedName || phone;

                membersMap.set(participant.id._serialized, {
                    name: name,
                    phone: phone,
                    isAdmin: participant.isAdmin
                });
            } catch (error) {
                // Fallback: use participant.id.user
                const phone = participant.id.user;
                membersMap.set(participant.id._serialized, {
                    name: phone,
                    phone: phone,
                    isAdmin: participant.isAdmin
                });
            }
        }

        // Store in cache
        groupMembersCache.set(groupId, membersMap);
        console.log(`✅ Cached ${membersMap.size} members for group`);

        // Show first 5 cached member IDs
        const cachedIds = Array.from(membersMap.keys()).slice(0, 5);
        console.log(`   Sample cached IDs:`, cachedIds);

        // Show their details
        cachedIds.forEach(id => {
            const member = membersMap.get(id);
            console.log(`     ${id} -> ${member.name} (${member.phone})`);
        });
    } catch (error) {
        console.error(`❌ Error caching members:`, error.message);
    }
}

// Per-user group member caching
async function cacheGroupMembersForUser(userId, groupId, userClient) {
    try {
        console.log(`🔄 Caching members for group ${groupId} (user ${userId})...`);

        const chat = await userClient.getChatById(groupId);
        if (!chat.isGroup || !chat.participants) {
            console.log(`⚠️ Not a group or no participants`);
            return;
        }

        const membersMap = new Map();

        // Process each participant
        for (const participant of chat.participants) {
            try {
                const contact = await userClient.getContactById(participant.id._serialized);
                const phone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || participant.id.user);
                const name = contact.pushname || contact.name || contact.verifiedName || phone;

                membersMap.set(participant.id._serialized, {
                    name: name,
                    phone: phone,
                    isAdmin: participant.isAdmin
                });
            } catch (error) {
                // Fallback: use participant.id.user
                const phone = participant.id.user;
                membersMap.set(participant.id._serialized, {
                    name: phone,
                    phone: phone,
                    isAdmin: participant.isAdmin
                });
            }
        }

        // Store in cache (shared cache is fine since member info is the same)
        groupMembersCache.set(groupId, membersMap);
        console.log(`✅ Cached ${membersMap.size} members for group (user ${userId})`);
    } catch (error) {
        console.error(`❌ Error caching members for user ${userId}:`, error.message);
    }
}

// ============================================
// PER-USER MONITORING SYSTEM
// ============================================

// Map to store monitoring intervals per user
const userMonitoringIntervals = new Map();

function startMonitoringForUser(userId, userClient) {
    // Clear any existing interval for this user
    if (userMonitoringIntervals.has(userId)) {
        clearInterval(userMonitoringIntervals.get(userId));
    }

    // Start checking immediately
    checkMessagesForUser(userId, userClient);

    // Then check every 60 seconds
    const interval = setInterval(() => {
        checkMessagesForUser(userId, userClient);
    }, CHECK_INTERVAL);

    userMonitoringIntervals.set(userId, interval);
    console.log(`⏰ Monitoring started for user ${userId} (checking every ${CHECK_INTERVAL / 1000}s)`);
}

async function checkMessagesForUser(userId, userClient) {
    const userGroups = userMonitoredGroups.get(userId);
    if (!userGroups || userGroups.size === 0) {
        return;
    }

    for (const [groupId, groupInfo] of userGroups) {
        await checkMessagesInGroup(userId, userClient, groupId, groupInfo);
    }
}

async function checkMessagesInGroup(userId, userClient, groupId, groupInfo) {
    const timestamp = new Date().toLocaleString();
    console.log(`[${timestamp}] User ${userId} - Checking ${groupInfo.name}...`);

    try {
        const chats = await userClient.getChats();
        const group = chats.find(chat => chat.id._serialized === groupId);

        if (!group) {
            console.error(`❌ User ${userId} - Group ${groupInfo.name} not found`);
            return;
        }

        // Check for member changes (joins/leaves)
        if (DETECT_JOINS_LEAVES && group.participants) {
            const currentMembers = new Set(group.participants.map(p => p.id._serialized));

            // Detect joins
            for (const memberId of currentMembers) {
                if (!groupInfo.previousMembers.has(memberId) && !groupInfo.isFirstRun) {
                    const event = await createEventForUser(userId, userClient, memberId, 'JOIN', groupInfo.name, groupId);
                    if (event) {
                        console.log(`🟢 User ${userId} - ${event.memberName} joined ${groupInfo.name}`);
                        broadcast({ type: 'event', event: event });
                    }
                }
            }

            // Detect leaves
            for (const memberId of groupInfo.previousMembers) {
                if (!currentMembers.has(memberId) && !groupInfo.isFirstRun) {
                    const event = await createEventForUser(userId, userClient, memberId, 'LEAVE', groupInfo.name, groupId);
                    if (event) {
                        console.log(`🔴 User ${userId} - ${event.memberName} left ${groupInfo.name}`);
                        broadcast({ type: 'event', event: event });
                    }
                }
            }

            groupInfo.previousMembers = currentMembers;
        }

        // Fetch and process messages
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
                const processed = await processMessageForUser(userId, userClient, msg, groupInfo.name, groupId);
                if (processed) {
                    processedMessages.push(processed);
                }
            }

            // Save messages to database with user_id
            const insertStmt = db.prepare(`
                INSERT OR REPLACE INTO messages (id, user_id, group_id, group_name, sender, sender_id, message, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const msg of processedMessages) {
                insertStmt.run(msg.id, userId, msg.groupId, msg.groupName, msg.sender, msg.senderId, msg.message, msg.timestamp);
            }

            insertStmt.finalize();

            if (!groupInfo.isFirstRun) {
                console.log(`🆕 User ${userId} - ${newMessages.length} new message(s) in ${groupInfo.name}`);

                // Broadcast new messages
                for (const msg of newMessages) {
                    const processed = await processMessageForUser(userId, userClient, msg, groupInfo.name, groupId);
                    if (processed) {
                        broadcast({ type: 'message', message: processed });
                    }
                }
            } else {
                console.log(`✅ User ${userId} - Loaded ${processedMessages.length} messages from ${groupInfo.name}`);
            }

            groupInfo.isFirstRun = false;
        } else {
            console.log(`   User ${userId} - No new messages in ${groupInfo.name}`);
        }

        // Clean up old message IDs
        if (groupInfo.previousMessageIds.size > 100) {
            const idsArray = Array.from(groupInfo.previousMessageIds);
            groupInfo.previousMessageIds = new Set(idsArray.slice(-100));
        }

    } catch (error) {
        console.error(`❌ User ${userId} - Error checking ${groupInfo.name}:`, error.message);
    }
}

async function processMessageForUser(userId, userClient, msg, groupName, groupId) {
    try {
        const timestamp = new Date(msg.timestamp * 1000);
        const cachedMembers = groupMembersCache.get(groupId);

        // Handle notification messages (joins, leaves) - skip saving these as messages
        if (msg.type === 'notification' || msg.type === 'notification_template' || msg.type === 'group_notification') {
            // These are handled separately by the member tracking system
            return null;
        }

        // Get message sender info
        const contact = await msg.getContact();
        let senderName = contact.pushname || contact.name || contact.verifiedName;
        let senderId = contact.id._serialized;

        // Try to get normalized ID and name from cache
        if (cachedMembers && cachedMembers.has(senderId)) {
            const cached = cachedMembers.get(senderId);
            senderName = cached.name;
        }

        // Check if it's a voice/audio message - create CERTIFICATE event
        if (msg.type === 'ptt' || msg.type === 'audio') {
            const event = await createEventForUser(userId, userClient, senderId, 'CERTIFICATE', groupName, groupId);
            if (event) {
                console.log(`🎤 User ${userId} - ${event.memberName} recorded certificate in ${groupName}`);
                broadcast({ type: 'event', event: event });
            }
        }

        // Save all messages (including voice messages) to database
        return {
            id: msg.id._serialized,
            groupId: groupId,
            groupName: groupName,
            sender: senderName,
            senderId: senderId,
            message: msg.body || '[Voice Message]',
            timestamp: timestamp.toISOString()
        };
    } catch (error) {
        console.error(`❌ Error processing message for user ${userId}:`, error.message);
        return null;
    }
}

async function createEventForUser(userId, userClient, memberId, eventType, groupName, groupId) {
    try {
        const contact = await userClient.getContactById(memberId);
        const memberPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || memberId.split('@')[0]);
        const memberName = contact.pushname || contact.name || contact.verifiedName || memberPhone;

        const timestamp = new Date();
        const eventDate = timestamp.toISOString().split('T')[0];

        const event = {
            groupId: groupId,
            groupName: groupName,
            memberId: memberPhone,
            memberName: memberName,
            type: eventType,
            timestamp: timestamp.toISOString(),
            date: eventDate
        };

        // Save to database with user_id
        if (eventType === 'JOIN') {
            db.run(`DELETE FROM events WHERE user_id = ? AND group_id = ? AND member_id = ? AND type = 'JOIN'`, [userId, groupId, memberPhone]);
            db.run(`
                INSERT INTO events (user_id, group_id, group_name, member_id, member_name, type, timestamp, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [userId, event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
        } else if (eventType === 'LEAVE') {
            db.run(`DELETE FROM events WHERE user_id = ? AND group_id = ? AND member_id = ? AND type = 'LEAVE'`, [userId, groupId, memberPhone]);
            db.run(`
                INSERT INTO events (user_id, group_id, group_name, member_id, member_name, type, timestamp, date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [userId, event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
        } else if (eventType === 'CERTIFICATE') {
            // Check if certificate already exists for today
            db.get(`
                SELECT * FROM events
                WHERE user_id = ? AND group_id = ? AND member_id = ? AND type = 'CERTIFICATE' AND date = ?
            `, [userId, groupId, memberPhone, eventDate], (err, row) => {
                if (!err && !row) {
                    db.run(`
                        INSERT INTO events (user_id, group_id, group_name, member_id, member_name, type, timestamp, date)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [userId, event.groupId, event.groupName, event.memberId, event.memberName, event.type, event.timestamp, eventDate]);
                }
            });
        }

        return event;
    } catch (error) {
        console.error(`❌ Error creating event for user ${userId}:`, error.message);
        return null;
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

        // Check if we have cached members for this group
        const cachedMembers = groupMembersCache.get(groupId);
        if (cachedMembers) {
            console.log(`📦 Using cached members for group (${cachedMembers.size} members cached)`);
        } else {
            console.log(`⚠️ No cached members for group ${groupId} - cache may need refresh`);
        }

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
                    // Extract phone using id.user first (like the working script)
                    const memberPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || memberId.split('@')[0]);
                    memberName = contact.pushname || contact.name || contact.verifiedName || memberPhone;
                } catch (e) {
                    memberName = memberId.split('@')[0];
                    console.log(`⚠️ Failed to get contact for member ${memberId}:`, e.message);
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

        // Handle regular messages - Use the original simple approach that was working
        let senderName = 'Unknown';
        let senderId = msg.author || '';
        let senderPhone = '';

        if (msg.author) {
            try {
                // Use msg.getContact() - the working approach from commit 5438c20
                const contact = await msg.getContact();

                // Extract phone number - try different properties
                if (contact.id && contact.id.user) {
                    senderPhone = contact.id.user;
                } else if (contact.number) {
                    senderPhone = contact.number;
                } else {
                    senderPhone = msg.author.split('@')[0];
                }

                // Get sender name with priority order
                senderName = contact.pushname || contact.name || contact.verifiedName || senderPhone;

                console.log(`✅ Resolved contact: ${senderName} (${senderPhone})`);
            } catch (e) {
                // Fallback: use author ID
                senderPhone = msg.author.split('@')[0];
                senderName = senderPhone;
                console.log(`⚠️ msg.getContact() failed: ${e.message}`);
                console.log(`   Using ID as fallback: ${senderName}\n`);
            }
        } else {
            senderPhone = 'Unknown';
            senderName = 'Unknown';
        }

        // Detect voice recordings (audio/ptt) and save as CERTIFICATE event
        if (msg.type === 'ptt' || msg.type === 'audio') {
            const timestampISO = timestamp.toISOString();
            const eventDate = timestampISO.substring(0, 10); // YYYY-MM-DD

            // Use phone number as member_id for deduplication (not WhatsApp ID)
            const memberIdForCert = senderPhone || senderId;

            // Delete previous CERTIFICATE event for this member (by phone) on this date
            db.run(`
                DELETE FROM events WHERE group_id = ? AND member_id = ? AND type = 'CERTIFICATE' AND date = ?
            `, [groupId, memberIdForCert, eventDate], () => {
                // Insert new CERTIFICATE event with phone number as member_id
                db.run(`
                    INSERT INTO events (group_id, group_name, member_id, member_name, type, timestamp, date)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [groupId, groupName, memberIdForCert, senderName, 'CERTIFICATE', timestampISO, eventDate]);

                console.log(`📜 Certificate recorded: ${senderName} (${memberIdForCert}) in ${groupName} on ${eventDate}`);

                // Broadcast certificate event
                broadcast({
                    type: 'event',
                    event: {
                        groupId: groupId,
                        groupName: groupName,
                        memberId: memberIdForCert,
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
        const memberPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || memberId.split('@')[0]);
        const memberName = contact.pushname || contact.name || contact.verifiedName || memberPhone;

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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 API Server running on http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket available at ws://0.0.0.0:${PORT}`);
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

    // Multi-tenant mode: WhatsApp clients initialize per-user when they login
    console.log('✅ Server ready. WhatsApp clients will initialize per user.\n');
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
