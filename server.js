// Testing group persistence across Railway deploys
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
const multer = require('multer');
const { MessageMedia, Poll } = require('whatsapp-web.js');
const schedule = require('node-schedule');

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

// Multer Configuration for file uploads
const upload = multer({
    storage: multer.memoryStorage(), // Store files in memory for processing
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

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

// Middleware to check if user is admin
function authenticateAdmin(req, res, next) {
    const userId = req.user.userId;

    db.get('SELECT is_admin FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (!row || !row.is_admin) {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

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
        checkInterval: 15000,
        messageLimit: 15,
        detectJoinsLeaves: true,
        port: 3000
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`📋 Created new config at: ${CONFIG_PATH}`);
}

// Extract configuration values AFTER loading from volume
const PORT = process.env.PORT || config.port || 3000;
const CHECK_INTERVAL = config.checkInterval || 15000;
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

        // Scheduled broadcasts table (stores broadcasts scheduled for future execution)
        db.run(`
            CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_ids TEXT NOT NULL,
                message TEXT,
                message_type TEXT DEFAULT 'text',
                poll_options TEXT,
                allow_multiple_answers BOOLEAN DEFAULT 0,
                gap_time INTEGER DEFAULT 10,
                scheduled_time DATETIME NOT NULL,
                status TEXT DEFAULT 'pending',
                file_data TEXT,
                file_mimetype TEXT,
                file_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                executed_at DATETIME,
                result_summary TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create welcome_message_settings table
        db.run(`
            CREATE TABLE IF NOT EXISTS welcome_message_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_id TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 0,
                message_text TEXT NOT NULL,
                member_threshold INTEGER DEFAULT 5,
                delay_minutes INTEGER DEFAULT 5,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, group_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create admin_only_schedule table
        db.run(`
            CREATE TABLE IF NOT EXISTS admin_only_schedule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_id TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 0,
                open_time TEXT NOT NULL,
                close_time TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, group_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Add mentions column to scheduled_broadcasts table if it doesn't exist
        db.run(`
            ALTER TABLE scheduled_broadcasts ADD COLUMN mentions TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding mentions column:', err);
            } else if (!err) {
                console.log('✅ Added mentions column to scheduled_broadcasts table');
            }
        });

        // Add image fields to welcome_message_settings table if they don't exist
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN image_enabled BOOLEAN DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding image_enabled column:', err);
            }
        });
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN image_data TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding image_data column:', err);
            }
        });
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN image_mimetype TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding image_mimetype column:', err);
            }
        });
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN image_filename TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding image_filename column:', err);
            }
        });
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN image_caption TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding image_caption column:', err);
            }
        });
        db.run(`ALTER TABLE welcome_message_settings ADD COLUMN specific_mentions TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding specific_mentions column:', err);
            }
        });

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

        // Add is_admin column to users table for admin privileges
        db.run(`
            ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding is_admin column:', err);
            } else if (!err) {
                console.log('✅ Added is_admin column to users table');
            }
        });

        // Add whatsapp_authenticated column to users table for quick lookup
        db.run(`
            ALTER TABLE users ADD COLUMN whatsapp_authenticated BOOLEAN DEFAULT 0
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding whatsapp_authenticated column:', err);
            } else if (!err) {
                console.log('✅ Added whatsapp_authenticated column to users table');
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

        // Add replied_to_message_id column to messages table for reply functionality
        db.run(`
            ALTER TABLE messages ADD COLUMN replied_to_message_id TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding replied_to_message_id column:', err);
            } else if (!err) {
                console.log('✅ Added replied_to_message_id column to messages table');
            }
        });

        // Add replied_to_sender column to messages table
        db.run(`
            ALTER TABLE messages ADD COLUMN replied_to_sender TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding replied_to_sender column:', err);
            } else if (!err) {
                console.log('✅ Added replied_to_sender column to messages table');
            }
        });

        // Add replied_to_message column to messages table
        db.run(`
            ALTER TABLE messages ADD COLUMN replied_to_message TEXT
        `, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding replied_to_message column:', err);
            } else if (!err) {
                console.log('✅ Added replied_to_message column to messages table');
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
        db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_user_id ON scheduled_broadcasts(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_scheduled_time ON scheduled_broadcasts(scheduled_time)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_status ON scheduled_broadcasts(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_welcome_settings_user_id ON welcome_message_settings(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_welcome_settings_group_id ON welcome_message_settings(group_id)`);

        console.log('✅ Database tables initialized');
    });
}

// In-memory storage for group info (lightweight, doesn't need persistence)
const groupInfoStore = new Map(); // groupId -> { name, id, memberCount }

// In-memory cache for group members: groupId -> Map(memberId -> {name, phone, isAdmin})
const groupMembersCache = new Map();

// Welcome message tracking: Map(userId_groupId -> {newMembers: [], timeoutId: number})
const pendingWelcomeMessages = new Map();

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

            console.log(`✅ User logged in: ${user.username} (${user.email}) - Admin: ${Boolean(user.is_admin)}`);

            res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    isAdmin: Boolean(user.is_admin),
                    whatsappAuthenticated: Boolean(user.whatsapp_authenticated)
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
    db.get('SELECT id, username, email, is_admin, whatsapp_authenticated, created_at FROM users WHERE id = ?', [req.user.userId], (err, user) => {
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
                isAdmin: Boolean(user.is_admin),
                whatsappAuthenticated: Boolean(user.whatsapp_authenticated),
                createdAt: user.created_at
            }
        });
    });
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all users (admin only) - for Super Admin dashboard
app.get('/api/admin/users', authenticateToken, authenticateAdmin, (req, res) => {
    db.all(`
        SELECT id, username, email, is_admin, whatsapp_authenticated, created_at
        FROM users
        ORDER BY whatsapp_authenticated DESC, created_at DESC
    `, [], (err, users) => {
        if (err) {
            console.error('Error fetching users:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        res.json({
            success: true,
            users: users.map(user => ({
                id: user.id,
                username: user.username,
                email: user.email,
                isAdmin: Boolean(user.is_admin),
                whatsappAuthenticated: Boolean(user.whatsapp_authenticated),
                createdAt: user.created_at
            }))
        });
    });
});

// TEMPORARY: Make current user admin (call once, then remove)
app.post('/api/admin/make-me-admin', authenticateToken, (req, res) => {
    const userId = req.user.userId;

    db.run('UPDATE users SET is_admin = 1 WHERE id = ?', [userId], (err) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, message: 'You are now admin. Logout and login again.' });
    });
});

// Update user admin status (admin only)
app.put('/api/admin/users/:userId/admin', authenticateToken, authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const { isAdmin } = req.body;

    if (typeof isAdmin !== 'boolean') {
        return res.status(400).json({
            success: false,
            error: 'isAdmin must be a boolean'
        });
    }

    db.run('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId], function(err) {
        if (err) {
            console.error('Error updating user admin status:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (this.changes === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            message: `User ${isAdmin ? 'granted' : 'revoked'} admin privileges`
        });
    });
});

// Delete user (admin only)
app.delete('/api/admin/users/:userId', authenticateToken, authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const requestingUserId = req.user.userId;

    // Prevent admin from deleting themselves
    if (parseInt(userId) === requestingUserId) {
        return res.status(400).json({
            success: false,
            error: 'You cannot delete your own account'
        });
    }

    // Delete user from database (CASCADE will handle related records)
    db.run('DELETE FROM users WHERE id = ?', [userId], function(err) {
        if (err) {
            console.error('Error deleting user:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (this.changes === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Clean up WhatsApp client if exists
        const userIdNum = parseInt(userId);
        const userClient = whatsappClients.get(userIdNum);
        if (userClient) {
            try {
                userClient.destroy();
            } catch (e) {
                console.error('Error destroying WhatsApp client:', e);
            }
            whatsappClients.delete(userIdNum);
        }

        // Clean up monitoring interval
        const intervalId = userMonitoringIntervals.get(userIdNum);
        if (intervalId) {
            clearInterval(intervalId);
            userMonitoringIntervals.delete(userIdNum);
        }

        // Clean up in-memory data
        userMonitoredGroups.delete(userIdNum);
        userClientReady.delete(userIdNum);
        userQRCodes.delete(userIdNum);
        userAuthStatus.delete(userIdNum);

        console.log(`✅ User ${userId} deleted successfully`);

        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    });
});

// ============================================
// WELCOME MESSAGE SETTINGS ENDPOINTS
// ============================================

// Get welcome message settings for a group
app.get('/api/welcome-settings/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;

    console.log(`📥 Getting welcome settings for user ${userId}, group ${groupId}`);

    db.get(`
        SELECT * FROM welcome_message_settings
        WHERE user_id = ? AND group_id = ?
    `, [userId, groupId], (err, row) => {
        if (err) {
            console.error('Error fetching welcome settings:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        console.log(`📤 Welcome settings result:`, row);

        res.json({
            success: true,
            settings: row || null
        });
    });
});

// Save or update welcome message settings for a group
app.post('/api/welcome-settings/:groupId', authenticateToken, upload.single('image'), (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { enabled, messageText, memberThreshold, delayMinutes, imageEnabled, imageCaption, specificMentions } = req.body;

    console.log(`💾 Saving welcome settings: user=${userId}, group=${groupId}, enabled=${enabled}, threshold=${memberThreshold}, delay=${delayMinutes}, imageEnabled=${imageEnabled}`);
    console.log(`🔍 Received specificMentions from frontend:`, specificMentions);
    console.log(`🔍 Type of specificMentions:`, typeof specificMentions);

    // Validation
    if (typeof enabled !== 'boolean' && enabled !== 'true' && enabled !== 'false') {
        return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
        });
    }

    if (!messageText || typeof messageText !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'messageText is required'
        });
    }

    if (!memberThreshold || memberThreshold < 1) {
        return res.status(400).json({
            success: false,
            error: 'memberThreshold must be at least 1'
        });
    }

    if (delayMinutes === undefined || delayMinutes < 0) {
        return res.status(400).json({
            success: false,
            error: 'delayMinutes must be at least 0'
        });
    }

    // Parse boolean values if they come as strings
    const enabledBool = enabled === true || enabled === 'true';
    const imageEnabledBool = imageEnabled === true || imageEnabled === 'true';

    // Handle image data
    let imageData = null;
    let imageMimetype = null;
    let imageFilename = null;

    if (req.file) {
        imageData = req.file.buffer.toString('base64');
        imageMimetype = req.file.mimetype;
        imageFilename = req.file.originalname;
    }

    // Parse specific mentions if provided
    const specificMentionsStr = specificMentions || '[]';

    // Insert or update
    db.run(`
        INSERT INTO welcome_message_settings (
            user_id, group_id, enabled, message_text, member_threshold, delay_minutes,
            image_enabled, image_data, image_mimetype, image_filename, image_caption, specific_mentions,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, group_id) DO UPDATE SET
            enabled = excluded.enabled,
            message_text = excluded.message_text,
            member_threshold = excluded.member_threshold,
            delay_minutes = excluded.delay_minutes,
            image_enabled = excluded.image_enabled,
            image_data = CASE WHEN excluded.image_data IS NOT NULL THEN excluded.image_data ELSE image_data END,
            image_mimetype = CASE WHEN excluded.image_mimetype IS NOT NULL THEN excluded.image_mimetype ELSE image_mimetype END,
            image_filename = CASE WHEN excluded.image_filename IS NOT NULL THEN excluded.image_filename ELSE image_filename END,
            image_caption = excluded.image_caption,
            specific_mentions = excluded.specific_mentions,
            updated_at = CURRENT_TIMESTAMP
    `, [userId, groupId, enabledBool ? 1 : 0, messageText, memberThreshold, delayMinutes,
        imageEnabledBool ? 1 : 0, imageData, imageMimetype, imageFilename, imageCaption, specificMentionsStr
    ], function(err) {
        if (err) {
            console.error('❌ Error saving welcome settings:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error: ' + err.message
            });
        }

        console.log(`✅ Welcome settings saved successfully for user ${userId}, group ${groupId}, changes=${this.changes}`);

        // Verify the save by reading it back
        db.get(`SELECT * FROM welcome_message_settings WHERE user_id = ? AND group_id = ?`, [userId, groupId], (err2, row) => {
            if (err2) {
                console.error('❌ Error verifying saved settings:', err2);
            } else {
                console.log(`🔍 Verification - settings now in DB:`, row ? 'Found' : 'Not found');
            }
        });

        res.json({
            success: true,
            message: 'Welcome message settings saved successfully'
        });
    });
});

// Delete welcome message settings for a group
app.delete('/api/welcome-settings/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;

    db.run(`
        DELETE FROM welcome_message_settings
        WHERE user_id = ? AND group_id = ?
    `, [userId, groupId], function(err) {
        if (err) {
            console.error('Error deleting welcome settings:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (this.changes === 0) {
            return res.status(404).json({
                success: false,
                error: 'Settings not found'
            });
        }

        res.json({
            success: true,
            message: 'Welcome message settings deleted successfully'
        });
    });
});

// ============================================
// ADMIN-ONLY MODE SCHEDULE ENDPOINTS
// ============================================

// Get admin-only schedule settings for a group
app.get('/api/admin-only-schedule/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;

    console.log(`📥 Getting admin-only schedule for user ${userId}, group ${groupId}`);

    db.get(`
        SELECT * FROM admin_only_schedule
        WHERE user_id = ? AND group_id = ?
    `, [userId, groupId], (err, row) => {
        if (err) {
            console.error('Error fetching admin-only schedule:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        console.log(`📤 Admin-only schedule result:`, row);

        res.json({
            success: true,
            settings: row || null
        });
    });
});

// Save or update admin-only schedule settings for a group
app.post('/api/admin-only-schedule/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;
    const { enabled, openTime, closeTime } = req.body;

    console.log(`💾 Saving admin-only schedule: user=${userId}, group=${groupId}, enabled=${enabled}, open=${openTime}, close=${closeTime}`);

    // Validation
    if (typeof enabled !== 'boolean' && enabled !== 'true' && enabled !== 'false') {
        return res.status(400).json({
            success: false,
            error: 'enabled must be a boolean'
        });
    }

    if (!openTime || typeof openTime !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'openTime is required'
        });
    }

    if (!closeTime || typeof closeTime !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'closeTime is required'
        });
    }

    // Parse boolean values if they come as strings
    const enabledBool = enabled === true || enabled === 'true';

    // Insert or update
    db.run(`
        INSERT INTO admin_only_schedule (user_id, group_id, enabled, open_time, close_time, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, group_id) DO UPDATE SET
            enabled = excluded.enabled,
            open_time = excluded.open_time,
            close_time = excluded.close_time,
            updated_at = CURRENT_TIMESTAMP
    `, [userId, groupId, enabledBool ? 1 : 0, openTime, closeTime], function(err) {
        if (err) {
            console.error('❌ Error saving admin-only schedule:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error: ' + err.message
            });
        }

        console.log(`✅ Admin-only schedule saved successfully for user ${userId}, group ${groupId}, changes=${this.changes}`);

        res.json({
            success: true,
            message: 'Admin-only schedule settings saved successfully'
        });
    });
});

// Delete admin-only schedule settings for a group
app.delete('/api/admin-only-schedule/:groupId', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const { groupId } = req.params;

    db.run(`
        DELETE FROM admin_only_schedule
        WHERE user_id = ? AND group_id = ?
    `, [userId, groupId], function(err) {
        if (err) {
            console.error('Error deleting admin-only schedule:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        if (this.changes === 0) {
            return res.status(404).json({
                success: false,
                error: 'Settings not found'
            });
        }

        res.json({
            success: true,
            message: 'Admin-only schedule settings deleted successfully'
        });
    });
});

// Debug endpoint - list all admin-only schedules
app.get('/api/debug/admin-only-schedules', authenticateToken, (req, res) => {
    const userId = req.user.userId;

    db.all(`
        SELECT * FROM admin_only_schedule WHERE user_id = ?
    `, [userId], (err, rows) => {
        if (err) {
            console.error('Error fetching all schedules:', err);
            return res.status(500).json({
                success: false,
                error: 'Database error'
            });
        }

        const now = new Date();
        const egyptTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
        const currentTime = `${String(egyptTime.getHours()).padStart(2, '0')}:${String(egyptTime.getMinutes()).padStart(2, '0')}`;

        res.json({
            success: true,
            currentTime: currentTime,
            timezone: 'Africa/Cairo (Egypt)',
            schedules: rows,
            clientReady: userClientReady.get(userId) || false,
            hasClient: whatsappClients.has(userId)
        });
    });
});

// Debug endpoint - manually trigger scheduler check
app.post('/api/debug/trigger-scheduler', authenticateToken, async (req, res) => {
    console.log('🔧 Manual scheduler trigger requested');

    try {
        await checkAndApplyAdminOnlySchedules();
        res.json({
            success: true,
            message: 'Scheduler triggered - check server logs for details'
        });
    } catch (error) {
        console.error('Error triggering scheduler:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// ADMIN VIEW USER DATA ENDPOINTS
// ============================================
// These endpoints allow admins to view any user's data

// Get groups for a specific user (admin only)
app.get('/api/admin/view-user/:userId/groups', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const userGroups = userMonitoredGroups.get(viewUserId);

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

// Get messages for a specific user (admin only)
app.get('/api/admin/view-user/:userId/messages', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    db.get('SELECT COUNT(*) as count FROM messages WHERE user_id = ?', [viewUserId], (err, countResult) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Database error' });
        }

        db.all(
            'SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
            [viewUserId, limit, offset],
            (err, rows) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Database error' });
                }

                res.json({
                    success: true,
                    messages: rows,
                    total: countResult.count,
                    limit: limit,
                    offset: offset
                });
            }
        );
    });
});

// Get messages from a specific group for a specific user (admin only)
app.get('/api/admin/view-user/:userId/messages/:groupId', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const groupId = req.params.groupId;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    db.get(
        'SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND group_id = ?',
        [viewUserId, groupId],
        (err, countResult) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Database error' });
            }

            db.all(
                'SELECT * FROM messages WHERE user_id = ? AND group_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
                [viewUserId, groupId, limit, offset],
                (err, rows) => {
                    if (err) {
                        return res.status(500).json({ success: false, error: 'Database error' });
                    }

                    res.json({
                        success: true,
                        messages: rows,
                        total: countResult.count,
                        limit: limit,
                        offset: offset
                    });
                }
            );
        }
    );
});

// Get events for a specific user (admin only)
app.get('/api/admin/view-user/:userId/events', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const date = req.query.date;
    const memberId = req.query.memberId;

    // Build WHERE clause dynamically
    let whereConditions = ['user_id = ?'];
    let params = [viewUserId];

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
            console.error('Admin events count error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get paginated events with filters (use column aliases to match frontend expectations)
        db.all(`
            SELECT id, group_id as groupId, group_name as groupName, member_id as memberId,
                   member_name as memberName, type, timestamp, date
            FROM events
            ${whereClause}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset], (err, rows) => {
            if (err) {
                console.error('Admin events query error:', err);
                return res.status(500).json({ success: false, error: err.message });
            }

            console.log(`Admin view events for user ${viewUserId}: found ${rows.length} events (total: ${countRow.total})`);

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

// Get stats for a specific user (admin only)
app.get('/api/admin/view-user/:userId/stats', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const dateParam = req.query.date;

    const stats = {
        groups: [],
        topSenders: [],
        totalMessages: 0,
        totalEvents: 0,
        totalJoins: 0,
        totalLeaves: 0,
        totalCertificates: 0,
        activeUsers: 0,
        dailyActivity: []
    };

    let dateFilter = '';
    let dateParams = [];
    if (dateParam) {
        if (dateParam.includes(',')) {
            const [startDate, endDate] = dateParam.split(',');
            dateFilter = ' AND date(timestamp) BETWEEN ? AND ?';
            dateParams = [startDate, endDate];
        } else {
            dateFilter = ' AND date(timestamp) = ?';
            dateParams = [dateParam];
        }
    }

    // Get active users count
    db.get(
        `SELECT COUNT(DISTINCT sender_id) as count FROM messages WHERE user_id = ?${dateFilter}`,
        [viewUserId, ...dateParams],
        (err, activeUsersResult) => {
            if (!err && activeUsersResult) stats.activeUsers = activeUsersResult.count;

            db.get(
                `SELECT COUNT(*) as count FROM messages WHERE user_id = ?${dateFilter}`,
                [viewUserId, ...dateParams],
                (err, result) => {
                    if (!err && result) stats.totalMessages = result.count;

                    db.all(
                        `SELECT sender, COUNT(*) as count FROM messages WHERE user_id = ?${dateFilter} GROUP BY sender ORDER BY count DESC LIMIT 10`,
                        [viewUserId, ...dateParams],
                        (err, senders) => {
                            if (!err) stats.topSenders = senders;

                            db.get(
                                `SELECT COUNT(*) as count FROM events WHERE user_id = ?${dateFilter.replace('timestamp', 'timestamp')}`,
                                [viewUserId, ...dateParams],
                                (err, result) => {
                                    if (!err && result) stats.totalEvents = result.count;

                                    db.get(
                                        `SELECT COUNT(*) as count FROM events WHERE user_id = ? AND type = 'JOIN'${dateFilter.replace('timestamp', 'timestamp')}`,
                                        [viewUserId, ...dateParams],
                                        (err, result) => {
                                            if (!err && result) stats.totalJoins = result.count;

                                            db.get(
                                                `SELECT COUNT(*) as count FROM events WHERE user_id = ? AND type = 'LEAVE'${dateFilter.replace('timestamp', 'timestamp')}`,
                                                [viewUserId, ...dateParams],
                                                (err, result) => {
                                                    if (!err && result) stats.totalLeaves = result.count;

                                                    db.get(
                                                        `SELECT COUNT(*) as count FROM events WHERE user_id = ? AND type = 'CERTIFICATE'${dateFilter.replace('timestamp', 'timestamp')}`,
                                                        [viewUserId, ...dateParams],
                                                        (err, result) => {
                                                            if (!err && result) stats.totalCertificates = result.count;

                                                            db.all(
                                                                `SELECT date(timestamp) as date, COUNT(*) as count FROM messages WHERE user_id = ?${dateFilter} GROUP BY date(timestamp) ORDER BY date DESC LIMIT 30`,
                                                                [viewUserId, ...dateParams],
                                                                (err, activity) => {
                                                                    if (!err) stats.dailyActivity = activity;

                                                                    // Get user's groups with detailed stats
                                                                    const userGroups = userMonitoredGroups.get(viewUserId);
                                                                    if (!userGroups || userGroups.size === 0) {
                                                                        return res.json({ success: true, stats });
                                                                    }

                                                                    const groupIds = Array.from(userGroups.keys());
                                                                    let processed = 0;

                                                                    groupIds.forEach(groupId => {
                                                                        const groupInfo = userGroups.get(groupId);

                                                                        // Build params for group queries
                                                                        const groupParams = [groupId, viewUserId];
                                                                        if (dateParam) {
                                                                            if (dateParam.includes(',')) {
                                                                                const [startDate, endDate] = dateParam.split(',');
                                                                                groupParams.push(startDate, endDate);
                                                                            } else {
                                                                                groupParams.push(dateParam);
                                                                            }
                                                                        }

                                                                        // Get message count for this group
                                                                        db.get(`SELECT COUNT(*) as count FROM messages WHERE group_id = ? AND user_id = ?${dateFilter}`, groupParams, (err, msgCount) => {
                                                                            if (err) {
                                                                                processed++;
                                                                                if (processed === groupIds.length) {
                                                                                    return res.json({ success: true, stats });
                                                                                }
                                                                                return;
                                                                            }

                                                                            // Get event count for this group
                                                                            db.get(`SELECT COUNT(*) as count FROM events WHERE group_id = ? AND user_id = ?${dateFilter}`, groupParams, (err, eventCount) => {
                                                                                if (err) {
                                                                                    processed++;
                                                                                    if (processed === groupIds.length) {
                                                                                        return res.json({ success: true, stats });
                                                                                    }
                                                                                    return;
                                                                                }

                                                                                // Get top senders for this group
                                                                                db.all(`
                                                                                    SELECT sender as name, COUNT(*) as count
                                                                                    FROM messages
                                                                                    WHERE group_id = ? AND user_id = ?${dateFilter}
                                                                                    GROUP BY sender
                                                                                    ORDER BY count DESC
                                                                                    LIMIT 5
                                                                                `, groupParams, (err, topSenders) => {
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
                                                                                        res.json({ success: true, stats });
                                                                                    }
                                                                                });
                                                                            });
                                                                        });
                                                                    });
                                                                }
                                                            );
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

// Get group members for a specific user (admin only)
app.get('/api/admin/view-user/:userId/groups/:groupId/members', authenticateToken, authenticateAdmin, async (req, res) => {
    try {
        const viewUserId = parseInt(req.params.userId);
        const groupId = req.params.groupId;

        const userClient = whatsappClients.get(viewUserId);
        if (!userClient || !userClientReady.get(viewUserId)) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client not ready for this user'
            });
        }

        const chat = await userClient.getChatById(groupId);
        if (!chat.isGroup) {
            return res.status(400).json({
                success: false,
                error: 'Not a group chat'
            });
        }

        const participants = chat.participants || [];
        const membersMap = groupMembersCache.get(groupId) || new Map();

        const members = await Promise.all(
            participants.map(async (participant) => {
                const cachedMember = membersMap.get(participant.id._serialized);
                if (cachedMember) {
                    return {
                        id: participant.id._serialized,
                        phone: cachedMember.phone,
                        name: cachedMember.name,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };
                }

                try {
                    const contact = await userClient.getContactById(participant.id._serialized);
                    const phone = participant.id.user;
                    const name = contact.pushname || contact.name || phone;

                    membersMap.set(participant.id._serialized, {
                        name: name,
                        phone: phone,
                        isAdmin: participant.isAdmin
                    });

                    return {
                        id: participant.id._serialized,
                        phone: phone,
                        name: name,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    };
                } catch (error) {
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

        groupMembersCache.set(groupId, membersMap);

        res.json({
            success: true,
            members: members,
            count: members.length
        });
    } catch (error) {
        console.error('Error fetching group members:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch group members'
        });
    }
});

// Get scheduled broadcasts for a specific user (admin only)
app.get('/api/admin/view-user/:userId/scheduled-broadcasts', authenticateToken, authenticateAdmin, (req, res) => {
    const viewUserId = parseInt(req.params.userId);
    const status = req.query.status || 'all'; // 'pending', 'sent', 'failed', 'all'

    console.log(`📅 Admin ${req.user.userId} requesting scheduled broadcasts for user ${viewUserId}, status: ${status}`);

    let query = `
        SELECT id, group_ids, message, message_type, poll_options,
               allow_multiple_answers, gap_time, scheduled_time, status,
               created_at, executed_at, result_summary,
               (file_data IS NOT NULL) as has_file, file_name
        FROM scheduled_broadcasts
        WHERE user_id = ?
    `;

    const params = [viewUserId];

    if (status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
    }

    query += ' ORDER BY scheduled_time DESC';

    console.log('Query:', query);
    console.log('Params:', params);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Error fetching scheduled broadcasts for user:', err);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch scheduled broadcasts'
            });
        }

        console.log(`📊 Raw rows from database: ${rows.length} rows`);
        console.log('Raw rows:', JSON.stringify(rows, null, 2));

        // Parse JSON fields
        const broadcasts = rows.map(row => ({
            ...row,
            group_ids: JSON.parse(row.group_ids),
            poll_options: row.poll_options ? JSON.parse(row.poll_options) : null,
            allow_multiple_answers: row.allow_multiple_answers === 1,
            has_file: row.has_file === 1
        }));

        console.log(`✅ Admin view scheduled broadcasts for user ${viewUserId}: found ${broadcasts.length} broadcasts`);

        res.json({
            success: true,
            broadcasts
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

        // Also update users table
        db.run(`
            UPDATE users
            SET whatsapp_authenticated = 0
            WHERE id = ?
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

// Get all WhatsApp groups/chats for broadcast
app.get('/api/whatsapp/all-chats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const userClient = whatsappClients.get(userId);

        if (!userClient || !userClientReady.get(userId)) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client not ready'
            });
        }

        // Get all chats
        const chats = await userClient.getChats();

        // Filter only groups and extract relevant info
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                isGroup: chat.isGroup
            }));

        res.json({
            success: true,
            groups: groups,
            count: groups.length
        });
    } catch (error) {
        console.error('Error fetching all chats:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch chats'
        });
    }
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

// Send message to a group
app.post('/api/messages/send', authenticateToken, upload.single('file'), async (req, res) => {
    const userId = req.user.userId;
    const { groupId, message, messageType, pollOptions, allowMultipleAnswers, replyToMessageId, mentions } = req.body;
    const file = req.file;

    try {
        // Check if user's WhatsApp client is ready
        const userClient = whatsappClients.get(userId);
        if (!userClient || !userClientReady.get(userId)) {
            return res.status(400).json({
                success: false,
                error: 'WhatsApp client not ready. Please connect your WhatsApp first.'
            });
        }

        // Verify user has access to this group
        const userGroups = userMonitoredGroups.get(userId);
        if (!userGroups || !userGroups.has(groupId)) {
            return res.status(403).json({
                success: false,
                error: 'You do not have access to this group'
            });
        }

        // Get the WhatsApp chat object
        const chat = await userClient.getChatById(groupId);
        if (!chat) {
            return res.status(404).json({
                success: false,
                error: 'Group not found'
            });
        }

        let sentMessage;

        // Handle different message types
        if (messageType === 'poll' && pollOptions) {
            // Send poll
            const options = JSON.parse(pollOptions);
            if (!options || options.length < 2) {
                return res.status(400).json({
                    success: false,
                    error: 'Poll must have at least 2 options'
                });
            }

            // Create Poll object (question, optionsArray, pollSendOptions)
            const allowMultiple = allowMultipleAnswers === 'true' || allowMultipleAnswers === true;
            const poll = new Poll(message, options, { allowMultipleAnswers: allowMultiple });
            sentMessage = await chat.sendMessage(poll);
        } else if (file) {
            // Send media (image, video, document)
            const media = new MessageMedia(
                file.mimetype,
                file.buffer.toString('base64'),
                file.originalname
            );

            sentMessage = await chat.sendMessage(media, {
                caption: message || ''
            });
        } else if (message && message.trim()) {
            // Send text message
            // Parse mentions if provided
            let parsedMentions = [];
            if (mentions) {
                try {
                    parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;
                } catch (e) {
                    console.error('Error parsing mentions:', e);
                }
            }

            const messageOptions = {};
            if (parsedMentions && parsedMentions.length > 0) {
                // Convert mention IDs to Contact objects
                const mentionContacts = [];
                for (const mentionId of parsedMentions) {
                    try {
                        const contact = await userClient.getContactById(mentionId);
                        if (contact) {
                            mentionContacts.push(contact);
                        }
                    } catch (err) {
                        console.error(`Error getting contact for mention ${mentionId}:`, err);
                    }
                }
                if (mentionContacts.length > 0) {
                    messageOptions.mentions = mentionContacts;
                }
            }

            if (replyToMessageId) {
                // Fetch the message to reply to
                const messages = await chat.fetchMessages({ limit: 1000 });
                const messageToReply = messages.find(msg => msg.id._serialized === replyToMessageId);

                if (messageToReply) {
                    sentMessage = await messageToReply.reply(message, null, messageOptions);
                } else {
                    // If message not found, send regular message with mentions
                    sentMessage = await chat.sendMessage(message, messageOptions);
                }
            } else {
                sentMessage = await chat.sendMessage(message, messageOptions);
            }
        } else {
            return res.status(400).json({
                success: false,
                error: 'Message content or file is required'
            });
        }

        // Get sender info (the logged-in user)
        const contact = await userClient.getContactById(sentMessage.from);
        const senderName = contact.pushname || contact.name || contact.verifiedName || contact.number || 'You';

        // Get reply information if this is a reply
        let repliedToMessageId = null;
        let repliedToSender = null;
        let repliedToMessage = null;

        if (sentMessage.hasQuotedMsg) {
            const quotedMsg = await sentMessage.getQuotedMessage();
            if (quotedMsg) {
                repliedToMessageId = quotedMsg.id._serialized;
                repliedToMessage = quotedMsg.body || '[Media]';

                // Get sender of quoted message
                try {
                    const quotedContact = await userClient.getContactById(quotedMsg.from);
                    repliedToSender = quotedContact.pushname || quotedContact.name || quotedContact.number || 'Unknown';
                } catch (err) {
                    repliedToSender = 'Unknown';
                }
            }
        }

        // Save sent message to database
        const messageData = {
            id: sentMessage.id._serialized,
            groupId: groupId,
            groupName: userGroups.get(groupId)?.name || 'Unknown',
            sender: senderName,
            senderId: sentMessage.from,
            message: messageType === 'poll' ? `📊 Poll: ${message}` : (message || getMediaTypeLabel(file?.mimetype)),
            timestamp: new Date(sentMessage.timestamp * 1000).toISOString(),
            repliedToMessageId,
            repliedToSender,
            repliedToMessage
        };

        db.run(`
            INSERT OR REPLACE INTO messages (id, user_id, group_id, group_name, sender, sender_id, message, timestamp, replied_to_message_id, replied_to_sender, replied_to_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            messageData.id,
            userId,
            messageData.groupId,
            messageData.groupName,
            messageData.sender,
            messageData.senderId,
            messageData.message,
            messageData.timestamp,
            messageData.repliedToMessageId,
            messageData.repliedToSender,
            messageData.repliedToMessage
        ], (err) => {
            if (err) {
                console.error('Error saving sent message to database:', err);
            }
        });

        // Broadcast the new message via WebSocket
        broadcast({
            type: 'message',
            userId: userId,
            message: messageData
        });

        res.json({
            success: true,
            message: messageData
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to send message'
        });
    }
});

// Helper function to get media type label
function getMediaTypeLabel(mimetype) {
    if (!mimetype) return '[Media]';
    if (mimetype.startsWith('image/')) return '[Image]';
    if (mimetype.startsWith('video/')) return '[Video]';
    if (mimetype.startsWith('audio/')) return '[Audio]';
    return '[Document]';
}

// Broadcast message to multiple groups
app.post('/api/messages/broadcast', authenticateToken, upload.single('file'), async (req, res) => {
    const userId = req.user.userId;
    const { groupIds, message, messageType, pollOptions, gapTime, allowMultipleAnswers, mentions } = req.body;
    const file = req.file;

    try {
        // Validate inputs
        if (!groupIds || !Array.isArray(JSON.parse(groupIds)) || JSON.parse(groupIds).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one group must be selected'
            });
        }

        const parsedGroupIds = JSON.parse(groupIds);
        const gapTimeMs = parseInt(gapTime) * 1000; // Convert seconds to milliseconds

        // Ensure minimum gap time of 10 seconds
        if (gapTimeMs < 10000) {
            return res.status(400).json({
                success: false,
                error: 'Gap time must be at least 10 seconds'
            });
        }

        // Check if user's WhatsApp client is ready
        const userClient = whatsappClients.get(userId);
        if (!userClient || !userClientReady.get(userId)) {
            return res.status(400).json({
                success: false,
                error: 'WhatsApp client not ready. Please connect your WhatsApp first.'
            });
        }

        const results = [];
        const errors = [];

        // Send to each group with delay
        for (let i = 0; i < parsedGroupIds.length; i++) {
            const groupId = parsedGroupIds[i];

            // Wait before sending to this group (except for the first one)
            if (i > 0) {
                console.log(`⏳ Waiting ${gapTime} seconds before next broadcast...`);
                await new Promise(resolve => setTimeout(resolve, gapTimeMs));
            }

            try {
                // Get the WhatsApp chat object
                const chat = await userClient.getChatById(groupId);
                if (!chat) {
                    errors.push({ groupId, error: 'Group not found' });
                    continue;
                }

                let sentMessage;

                // Handle different message types (same logic as regular send)
                if (messageType === 'poll' && pollOptions) {
                    const options = JSON.parse(pollOptions);
                    if (!options || options.length < 2) {
                        errors.push({ groupId, error: 'Poll must have at least 2 options' });
                        continue;
                    }

                    const allowMultiple = allowMultipleAnswers === 'true' || allowMultipleAnswers === true;
                    const poll = new Poll(message, options, { allowMultipleAnswers: allowMultiple });
                    sentMessage = await chat.sendMessage(poll);
                } else if (file) {
                    const media = new MessageMedia(
                        file.mimetype,
                        file.buffer.toString('base64'),
                        file.originalname
                    );

                    sentMessage = await chat.sendMessage(media, {
                        caption: message || ''
                    });
                } else if (message && message.trim()) {
                    // Parse mentions if provided
                    let parsedMentions = [];
                    if (mentions) {
                        try {
                            parsedMentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;
                        } catch (e) {
                            console.error('Error parsing mentions:', e);
                        }
                    }

                    const messageOptions = {};
                    if (parsedMentions && parsedMentions.length > 0) {
                        // Convert mention IDs to Contact objects
                        const mentionContacts = [];
                        for (const mentionId of parsedMentions) {
                            try {
                                const contact = await userClient.getContactById(mentionId);
                                if (contact) {
                                    mentionContacts.push(contact);
                                }
                            } catch (err) {
                                console.error(`Error getting contact for mention ${mentionId}:`, err);
                            }
                        }
                        if (mentionContacts.length > 0) {
                            messageOptions.mentions = mentionContacts;
                        }
                    }

                    sentMessage = await chat.sendMessage(message, messageOptions);
                } else {
                    errors.push({ groupId, error: 'Message content or file is required' });
                    continue;
                }

                results.push({
                    groupId,
                    messageId: sentMessage.id._serialized,
                    success: true
                });

                console.log(`✅ Broadcast message sent to group ${groupId}`);
            } catch (error) {
                console.error(`❌ Error sending to group ${groupId}:`, error);
                errors.push({ groupId, error: error.message });
            }
        }

        res.json({
            success: true,
            results,
            errors,
            totalSent: results.length,
            totalFailed: errors.length,
            message: `Broadcast completed: ${results.length} sent, ${errors.length} failed`
        });
    } catch (error) {
        console.error('Error in broadcast:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to broadcast message'
        });
    }
});

// Schedule a broadcast for future execution
app.post('/api/messages/broadcast/schedule', authenticateToken, upload.single('file'), async (req, res) => {
    const userId = req.user.userId;
    const { groupIds, message, messageType, pollOptions, gapTime, allowMultipleAnswers, scheduledTime, mentions } = req.body;
    const file = req.file;

    try {
        // Validate inputs
        if (!groupIds || !Array.isArray(JSON.parse(groupIds)) || JSON.parse(groupIds).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one group must be selected'
            });
        }

        if (!scheduledTime) {
            return res.status(400).json({
                success: false,
                error: 'Scheduled time is required'
            });
        }

        const scheduledDate = new Date(scheduledTime);
        const now = new Date();

        // Validate scheduled time is in the future
        if (scheduledDate <= now) {
            return res.status(400).json({
                success: false,
                error: 'Scheduled time must be in the future'
            });
        }

        const parsedGroupIds = JSON.parse(groupIds);

        // Store file as base64 if present
        let fileData = null;
        let fileMimetype = null;
        let fileName = null;
        if (file) {
            fileData = file.buffer.toString('base64');
            fileMimetype = file.mimetype;
            fileName = file.originalname;
        }

        // Insert scheduled broadcast into database
        db.run(`
            INSERT INTO scheduled_broadcasts (
                user_id, group_ids, message, message_type, poll_options,
                allow_multiple_answers, gap_time, scheduled_time, status,
                file_data, file_mimetype, file_name, mentions
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            userId,
            JSON.stringify(parsedGroupIds),
            message || null,
            messageType || 'text',
            pollOptions || null,
            allowMultipleAnswers === 'true' || allowMultipleAnswers === true ? 1 : 0,
            parseInt(gapTime) || 10,
            scheduledDate.toISOString(),
            'pending',
            fileData,
            fileMimetype,
            fileName,
            mentions || null
        ], function(err) {
            if (err) {
                console.error('Error scheduling broadcast:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to schedule broadcast'
                });
            }

            console.log(`📅 Broadcast scheduled for ${scheduledDate.toISOString()} (ID: ${this.lastID})`);
            res.json({
                success: true,
                scheduleId: this.lastID,
                scheduledTime: scheduledDate.toISOString(),
                message: `Broadcast scheduled for ${scheduledDate.toLocaleString()}`
            });
        });
    } catch (error) {
        console.error('Error scheduling broadcast:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to schedule broadcast'
        });
    }
});

// Get user's scheduled broadcasts
app.get('/api/messages/broadcast/scheduled', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const status = req.query.status || 'all'; // 'pending', 'sent', 'failed', 'all'

    let query = `
        SELECT id, group_ids, message, message_type, poll_options,
               allow_multiple_answers, gap_time, scheduled_time, status,
               created_at, executed_at, result_summary,
               (file_data IS NOT NULL) as has_file, file_name
        FROM scheduled_broadcasts
        WHERE user_id = ?
    `;

    const params = [userId];

    if (status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
    }

    query += ' ORDER BY scheduled_time DESC';

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Error fetching scheduled broadcasts:', err);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch scheduled broadcasts'
            });
        }

        // Parse JSON fields
        const broadcasts = rows.map(row => ({
            ...row,
            group_ids: JSON.parse(row.group_ids),
            poll_options: row.poll_options ? JSON.parse(row.poll_options) : null,
            allow_multiple_answers: row.allow_multiple_answers === 1,
            has_file: row.has_file === 1
        }));

        res.json({
            success: true,
            broadcasts
        });
    });
});

// Cancel (delete) a scheduled broadcast
app.delete('/api/messages/broadcast/scheduled/:id', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const scheduleId = req.params.id;

    // First check if the broadcast belongs to the user and is still pending
    db.get(`
        SELECT id, status, scheduled_time
        FROM scheduled_broadcasts
        WHERE id = ? AND user_id = ?
    `, [scheduleId, userId], (err, row) => {
        if (err) {
            console.error('Error checking scheduled broadcast:', err);
            return res.status(500).json({
                success: false,
                error: 'Failed to check scheduled broadcast'
            });
        }

        if (!row) {
            return res.status(404).json({
                success: false,
                error: 'Scheduled broadcast not found'
            });
        }

        if (row.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: `Cannot cancel a broadcast with status: ${row.status}`
            });
        }

        // Delete the scheduled broadcast
        db.run(`
            DELETE FROM scheduled_broadcasts
            WHERE id = ? AND user_id = ?
        `, [scheduleId, userId], function(err) {
            if (err) {
                console.error('Error deleting scheduled broadcast:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to cancel scheduled broadcast'
                });
            }

            console.log(`🗑️ Scheduled broadcast ${scheduleId} cancelled by user ${userId}`);
            res.json({
                success: true,
                message: 'Scheduled broadcast cancelled successfully'
            });
        });
    });
});

// Update scheduled broadcast time
app.put('/api/messages/broadcast/scheduled/:id', authenticateToken, (req, res) => {
    const userId = req.user.userId;
    const scheduleId = req.params.id;
    const { scheduledTime } = req.body;

    if (!scheduledTime) {
        return res.status(400).json({
            success: false,
            error: 'New scheduled time is required'
        });
    }

    const newScheduledDate = new Date(scheduledTime);
    const now = new Date();

    // Validate scheduled time is in the future
    if (newScheduledDate <= now) {
        return res.status(400).json({
            success: false,
            error: 'Scheduled time must be in the future'
        });
    }

    // First check if the broadcast belongs to the user and is still pending
    db.get(`
        SELECT id, status
        FROM scheduled_broadcasts
        WHERE id = ? AND user_id = ?
    `, [scheduleId, userId], (err, row) => {
        if (err) {
            console.error('Error checking scheduled broadcast:', err);
            return res.status(500).json({
                success: false,
                error: 'Failed to check scheduled broadcast'
            });
        }

        if (!row) {
            return res.status(404).json({
                success: false,
                error: 'Scheduled broadcast not found'
            });
        }

        if (row.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: `Cannot update a broadcast with status: ${row.status}`
            });
        }

        // Update the scheduled time
        db.run(`
            UPDATE scheduled_broadcasts
            SET scheduled_time = ?
            WHERE id = ? AND user_id = ?
        `, [newScheduledDate.toISOString(), scheduleId, userId], function(err) {
            if (err) {
                console.error('Error updating scheduled broadcast:', err);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to update scheduled broadcast'
                });
            }

            console.log(`📅 Scheduled broadcast ${scheduleId} updated to ${newScheduledDate.toISOString()}`);
            res.json({
                success: true,
                scheduledTime: newScheduledDate.toISOString(),
                message: `Scheduled time updated to ${newScheduledDate.toLocaleString()}`
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
    const dateParam = req.query.date; // Format: "YYYY-MM-DD" or "YYYY-MM-DD,YYYY-MM-DD"

    const stats = {
        groups: [],
        totalMessages: 0,
        totalEvents: 0,
        activeUsers: 0
    };

    // Build date filter for queries
    let dateFilter = '';
    let dateParams = [userId];

    if (dateParam) {
        if (dateParam.includes(',')) {
            // Date range
            const [startDate, endDate] = dateParam.split(',');
            dateFilter = ' AND DATE(timestamp) BETWEEN ? AND ?';
            dateParams.push(startDate, endDate);
        } else {
            // Single date
            dateFilter = ' AND DATE(timestamp) = ?';
            dateParams.push(dateParam);
        }
    }

    // Get total message count for this user (with optional date filter)
    db.get(`SELECT COUNT(*) as total FROM messages WHERE user_id = ?${dateFilter}`, dateParams, (err, msgCountRow) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }

        // Get total event count for this user (with optional date filter)
        db.get(`SELECT COUNT(*) as total FROM events WHERE user_id = ?${dateFilter}`, dateParams, (err, eventCountRow) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }

            // Get active users count (distinct senders who sent messages in date range)
            db.get(`SELECT COUNT(DISTINCT sender_id) as total FROM messages WHERE user_id = ?${dateFilter}`, dateParams, (err, activeUsersRow) => {
                if (err) {
                    return res.status(500).json({ success: false, error: err.message });
                }

                stats.totalMessages = msgCountRow.total;
                stats.totalEvents = eventCountRow.total;
                stats.activeUsers = activeUsersRow.total;

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

                // Build params for group queries
                const groupParams = [groupId, userId];
                if (dateParam) {
                    if (dateParam.includes(',')) {
                        const [startDate, endDate] = dateParam.split(',');
                        groupParams.push(startDate, endDate);
                    } else {
                        groupParams.push(dateParam);
                    }
                }

                // Get message count for this group and user (with date filter)
                db.get(`SELECT COUNT(*) as count FROM messages WHERE group_id = ? AND user_id = ?${dateFilter}`, groupParams, (err, msgCount) => {
                    if (err) {
                        processed++;
                        if (processed === groupIds.length) {
                            return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                        }
                        return;
                    }

                    // Get event count for this group and user (with date filter)
                    db.get(`SELECT COUNT(*) as count FROM events WHERE group_id = ? AND user_id = ?${dateFilter}`, groupParams, (err, eventCount) => {
                        if (err) {
                            processed++;
                            if (processed === groupIds.length) {
                                return res.json({ success: true, stats, timestamp: new Date().toISOString() });
                            }
                            return;
                        }

                        // Get top senders for this group and user (with date filter)
                        db.all(`
                            SELECT sender as name, COUNT(*) as count
                            FROM messages
                            WHERE group_id = ? AND user_id = ?${dateFilter}
                            GROUP BY sender
                            ORDER BY count DESC
                            LIMIT 5
                        `, groupParams, (err, topSenders) => {
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

        // Immediately check messages for this new group (with error handling)
        const groupData = userMonitoredGroups.get(userId).get(groupId);
        try {
            await checkMessagesInGroup(userId, userClient, groupId, groupData);
        } catch (msgError) {
            console.error(`⚠️  Error checking messages for new group ${group.name}:`, msgError.message);
            // Don't fail the entire request - group was added successfully
        }

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

    // Try to find chromium in nix store (Railway/Linux)
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

    // Try to find Chrome on macOS
    const macChromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        process.env.HOME + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];

    for (const chromePath of macChromePaths) {
        if (fs.existsSync(chromePath)) {
            console.log('✅ Found Chrome at:', chromePath);
            return chromePath;
        }
    }

    console.log('⚠️  No Chrome/Chromium found, using Puppeteer default');
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
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
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
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
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
    // Recursively find and remove all SingletonLock files
    console.log(`🔍 Searching for lock files in: ${authPath}`);

    function removeLockFilesRecursively(dir, depth = 0) {
        let removed = 0;
        try {
            if (fs.existsSync(dir)) {
                const items = fs.readdirSync(dir);
                if (depth === 0 || items.length > 0) {
                    console.log(`${'  '.repeat(depth)}📁 Checking directory: ${dir} (${items.length} items)`);
                }

                for (const item of items) {
                    const fullPath = path.join(dir, item);

                    // Remove any file starting with "Singleton" (lock, socket, cookie, etc.)
                    if (item.startsWith('Singleton')) {
                        try {
                            console.log(`${'  '.repeat(depth)}🔒 Found Chromium file: ${fullPath}`);
                            fs.unlinkSync(fullPath);
                            removed++;
                            console.log(`${'  '.repeat(depth)}🧹 Removed: ${fullPath}`);
                        } catch (e) {
                            console.log(`${'  '.repeat(depth)}⚠️  Failed to remove ${item}:`, e.message);
                        }
                        continue;
                    }

                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.isDirectory()) {
                            removed += removeLockFilesRecursively(fullPath, depth + 1);
                        }
                    } catch (e) {
                        // Skip files we can't access
                    }
                }
            } else {
                console.log(`⚠️  Directory does not exist: ${dir}`);
            }
        } catch (e) {
            console.log(`❌ Error reading directory ${dir}:`, e.message);
        }
        return removed;
    }

    const cleanedLocks = removeLockFilesRecursively(authPath);
    console.log(`🧹 Lock file cleanup complete. Removed ${cleanedLocks} file(s) for user ${userId}`);

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

            // Also update users table for quick admin lookups
            db.run(`
                UPDATE users
                SET whatsapp_authenticated = 1
                WHERE id = ?
            `, [userId]);
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

    // Handle real-time group join events
    userClient.on('group_join', async (notification) => {
        const groupId = notification.chatId._serialized;
        const userGroups = userMonitoredGroups.get(userId);
        const groupInfo = userGroups ? userGroups.get(groupId) : null;

        if (groupInfo) {
            const newMembers = [];
            for (const participant of notification.recipientIds) {
                // Correct parameter order: (userId, userClient, memberId, eventType, groupName, groupId)
                const event = await createEventForUser(userId, userClient, participant._serialized, 'JOIN', groupInfo.name, groupId);
                if (event) {
                    console.log(`🟢 User ${userId}: ${event.memberName} joined ${groupInfo.name}`);
                    broadcast({ type: 'event', userId: userId, event: event });
                    newMembers.push({
                        id: participant._serialized,
                        name: event.memberName,
                        phone: event.memberId
                    });
                }
            }

            // Check and trigger welcome message if configured
            if (newMembers.length > 0) {
                await checkAndTriggerWelcomeMessage(userId, userClient, groupId, groupInfo.name, newMembers);
            }
        }
    });

    // Handle real-time group leave events
    userClient.on('group_leave', async (notification) => {
        const groupId = notification.chatId._serialized;
        const userGroups = userMonitoredGroups.get(userId);
        const groupInfo = userGroups ? userGroups.get(groupId) : null;

        if (groupInfo) {
            for (const participant of notification.recipientIds) {
                // Correct parameter order: (userId, userClient, memberId, eventType, groupName, groupId)
                const event = await createEventForUser(userId, userClient, participant._serialized, 'LEAVE', groupInfo.name, groupId);
                if (event) {
                    console.log(`🔴 User ${userId}: ${event.memberName} left ${groupInfo.name}`);
                    broadcast({ type: 'event', userId: userId, event: event });
                }
            }
        }
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
    try {
        const userGroups = userMonitoredGroups.get(userId);
        if (!userGroups || userGroups.size === 0) {
            return;
        }

        for (const [groupId, groupInfo] of userGroups) {
            try {
                await checkMessagesInGroup(userId, userClient, groupId, groupInfo);
            } catch (error) {
                console.error(`❌ Error checking group ${groupInfo.name} for user ${userId}:`, error.message);
                // Continue with next group even if this one fails
            }
        }
    } catch (error) {
        console.error(`❌ Critical error in checkMessagesForUser for user ${userId}:`, error.message);
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
            const newJoinedMembers = [];
            for (const memberId of currentMembers) {
                if (!groupInfo.previousMembers.has(memberId) && !groupInfo.isFirstRun) {
                    const event = await createEventForUser(userId, userClient, memberId, 'JOIN', groupInfo.name, groupId);
                    if (event) {
                        console.log(`🟢 User ${userId} - ${event.memberName} joined ${groupInfo.name}`);
                        broadcast({ type: 'event', event: event });

                        // Add to list for welcome message
                        newJoinedMembers.push({
                            id: memberId,
                            name: event.memberName,
                            phone: event.memberId
                        });
                    }
                }
            }

            // Trigger welcome message if members joined
            if (newJoinedMembers.length > 0) {
                await checkAndTriggerWelcomeMessage(userId, userClient, groupId, groupInfo.name, newJoinedMembers);
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

            // Only process NEW messages (not all fetched messages) for better performance
            const messagesToProcess = groupInfo.isFirstRun ? messages : newMessages;

            for (const msg of messagesToProcess) {
                const processed = await processMessageForUser(userId, userClient, msg, groupInfo.name, groupId);
                if (processed) {
                    processedMessages.push(processed);
                }
            }

            // Save messages to database with user_id (only if there are processed messages)
            if (processedMessages.length > 0) {
                const insertStmt = db.prepare(`
                    INSERT OR REPLACE INTO messages (id, user_id, group_id, group_name, sender, sender_id, message, timestamp, replied_to_message_id, replied_to_sender, replied_to_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const msg of processedMessages) {
                    insertStmt.run(msg.id, userId, msg.groupId, msg.groupName, msg.sender, msg.senderId, msg.message, msg.timestamp, msg.repliedToMessageId, msg.repliedToSender, msg.repliedToMessage);
                }

                insertStmt.finalize();
            }

            if (!groupInfo.isFirstRun && newMessages.length > 0) {
                console.log(`🆕 User ${userId} - ${newMessages.length} new message(s) in ${groupInfo.name}`);

                // Broadcast already-processed new messages (no need to reprocess)
                for (const processed of processedMessages) {
                    broadcast({ type: 'message', message: processed });
                }
            } else if (groupInfo.isFirstRun) {
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

        // Debug log for non-standard message types (disabled for performance)
        // console.log(`🔍 User ${userId} - Message type: ${msg.type}, hasMedia: ${msg.hasMedia}, body: "${msg.body?.substring(0, 50) || 'empty'}", subtype: ${msg.subtype}`);

        // Handle notification messages (joins, leaves) - including gp2 type
        if (msg.type === 'notification' || msg.type === 'notification_template' || msg.type === 'group_notification' || msg.type === 'gp2') {
            let notificationMessage = msg.body || 'Group notification';
            let eventType = null;
            let memberId = null;
            let memberName = 'Unknown';

            // Reduced logging for performance
            // console.log(`📋 User ${userId} - Notification details:`, { type: msg.type, subtype: msg.subtype });

            // Try to detect if it's a join or leave event
            if (msg.recipientIds && msg.recipientIds.length > 0) {
                memberId = msg.recipientIds[0];

                // Get member name and phone
                try {
                    const contact = await userClient.getContactById(memberId);
                    const memberPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || memberId.split('@')[0]);
                    memberName = contact.pushname || contact.name || contact.verifiedName || memberPhone;
                } catch (e) {
                    memberName = memberId.split('@')[0];
                    console.log(`⚠️  User ${userId} - Failed to get contact for member ${memberId}:`, e.message);
                }

                // Determine if it's a join or leave based on notification subtype
                if (msg.subtype === 'add' || msg.subtype === 'invite' || msg.subtype === 'group_invite_link') {
                    eventType = 'JOIN';
                    if (!msg.body || msg.body.trim() === '') {
                        if (msg.subtype === 'group_invite_link') {
                            notificationMessage = `${memberName} joined via group link`;
                        } else {
                            notificationMessage = `${memberName} joined`;
                        }
                    }
                } else if (msg.subtype === 'remove' || msg.subtype === 'leave') {
                    eventType = 'LEAVE';
                    if (!msg.body || msg.body.trim() === '') {
                        notificationMessage = `${memberName} left`;
                    }
                }

                // Save to events table if we detected the event type
                if (eventType && memberId) {
                    const event = await createEventForUser(userId, userClient, memberId, eventType, groupName, groupId, timestamp);
                    if (event) {
                        console.log(`📝 User ${userId} - Detected ${eventType} event: ${memberName} in ${groupName}`);
                        broadcast({ type: 'event', event: event });

                        // Trigger welcome message if it's a JOIN event
                        if (eventType === 'JOIN') {
                            const newMember = {
                                id: memberId,
                                name: memberName,
                                phone: event.memberId
                            };
                            await checkAndTriggerWelcomeMessage(userId, userClient, groupId, groupName, [newMember]);
                        }
                    }
                }
            }

            // Return the notification as a message for display in chat
            return {
                id: msg.id._serialized,
                groupId: groupId,
                groupName: groupName,
                sender: 'System',
                senderId: '',
                message: notificationMessage || 'Group notification',
                timestamp: timestamp.toISOString()
            };
        }

        // Get message sender info
        const contact = await msg.getContact();
        let senderId = contact.id._serialized;
        let senderName = contact.pushname || contact.name || contact.verifiedName || contact.number || senderId.split('@')[0] || 'Unknown';

        // Extract phone number from contact ID
        let senderPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || senderId.split('@')[0]);

        // Try to get normalized ID and name from cache
        if (cachedMembers && cachedMembers.has(senderId)) {
            const cached = cachedMembers.get(senderId);
            senderName = cached.name || senderName;
            senderPhone = cached.phone || senderPhone;
        }

        // Ensure senderName is never null or undefined
        if (!senderName || senderName === 'undefined') {
            senderName = senderId.split('@')[0] || 'Unknown';
        }

        // Format as "Name (PhoneNumber)" if phone is different from name
        let senderDisplay = senderName;
        if (senderPhone && senderName !== senderPhone && senderPhone !== 'Unknown') {
            senderDisplay = `${senderName} (${senderPhone})`;
        }

        // Check if it's a voice/audio message - create CERTIFICATE event
        if (msg.type === 'ptt' || msg.type === 'audio') {
            const event = await createEventForUser(userId, userClient, senderId, 'CERTIFICATE', groupName, groupId, timestamp);
            if (event) {
                console.log(`🎤 User ${userId} - ${event.memberName} recorded certificate in ${groupName}`);
                broadcast({ type: 'event', event: event });
            }
        }

        // Determine message content based on type
        let messageContent = msg.body;
        if (!messageContent || messageContent.trim() === '') {
            // Handle different media types
            switch (msg.type) {
                case 'ptt':
                case 'audio':
                    messageContent = '[Voice Message]';
                    break;
                case 'image':
                    messageContent = '[Image]';
                    break;
                case 'video':
                    messageContent = '[Video]';
                    break;
                case 'document':
                    messageContent = '[Document]';
                    break;
                case 'sticker':
                    messageContent = '[Sticker]';
                    break;
                default:
                    messageContent = '[Media]';
            }
        }

        // Get reply information if this message is a reply
        let repliedToMessageId = null;
        let repliedToSender = null;
        let repliedToMessage = null;

        if (msg.hasQuotedMsg) {
            try {
                const quotedMsg = await msg.getQuotedMessage();
                if (quotedMsg) {
                    repliedToMessageId = quotedMsg.id._serialized;
                    repliedToMessage = quotedMsg.body || '[Media]';

                    // Get sender of quoted message
                    try {
                        const quotedContact = await userClient.getContactById(quotedMsg.from);
                        const quotedPhone = quotedContact.id.user || quotedContact.number || '';
                        const quotedName = quotedContact.pushname || quotedContact.name || quotedPhone;
                        repliedToSender = quotedName;
                    } catch (err) {
                        repliedToSender = 'Unknown';
                    }
                }
            } catch (err) {
                console.log(`⚠️  User ${userId} - Failed to get quoted message:`, err.message);
            }
        }

        // Save all messages to database
        return {
            id: msg.id._serialized,
            groupId: groupId,
            groupName: groupName,
            sender: senderDisplay,
            senderId: senderId,
            message: messageContent,
            timestamp: timestamp.toISOString(),
            repliedToMessageId,
            repliedToSender,
            repliedToMessage
        };
    } catch (error) {
        console.error(`❌ Error processing message for user ${userId}:`, error.message);
        return null;
    }
}

// Check and trigger welcome message for new members
async function checkAndTriggerWelcomeMessage(userId, userClient, groupId, groupName, newMembers) {
    try {
        console.log(`🔍 Checking welcome message for user ${userId}, group ${groupId}, ${newMembers.length} new member(s)`);

        // Get welcome message settings for this group
        const settings = await new Promise((resolve, reject) => {
            db.get(`
                SELECT * FROM welcome_message_settings
                WHERE user_id = ? AND group_id = ? AND enabled = 1
            `, [userId, groupId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!settings) {
            // No welcome message configured or disabled
            console.log(`⚠️  No enabled welcome message settings found for user ${userId}, group ${groupId}`);
            return;
        }

        console.log(`✅ Found welcome settings: threshold=${settings.member_threshold}, delay=${settings.delay_minutes} mins`);

        const key = `${userId}_${groupId}`;
        let pending = pendingWelcomeMessages.get(key);

        if (!pending) {
            // Initialize pending welcome message tracking
            pending = {
                newMembers: [],
                timeoutId: null
            };
            pendingWelcomeMessages.set(key, pending);
        }

        // Add new members to the list
        pending.newMembers.push(...newMembers);

        // Clear existing timeout if any
        if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
        }

        // Check if we've reached the threshold
        if (pending.newMembers.length >= settings.member_threshold) {
            // Set timeout to send message after delay
            const delayMs = settings.delay_minutes * 60 * 1000;
            pending.timeoutId = setTimeout(async () => {
                await sendWelcomeMessage(userId, userClient, groupId, groupName, settings, pending.newMembers);
                // Clear the pending list
                pendingWelcomeMessages.delete(key);
            }, delayMs);

            console.log(`⏰ Welcome message scheduled for ${groupName} in ${settings.delay_minutes} minutes for ${pending.newMembers.length} members`);
        }
    } catch (error) {
        console.error('Error checking welcome message trigger:', error);
    }
}

// Send welcome message with mentions
async function sendWelcomeMessage(userId, userClient, groupId, groupName, settings, members) {
    try {
        console.log(`👋 Sending welcome message to ${groupName} for ${members.length} new members`);

        // Get the chat
        const chat = await userClient.getChatById(groupId);
        if (!chat) {
            console.error('Chat not found for welcome message');
            return;
        }

        // Build mentions array for new members as Contact objects
        const mentionContacts = [];
        for (const member of members) {
            try {
                const contact = await userClient.getContactById(member.id);
                if (contact) {
                    mentionContacts.push(contact);
                }
            } catch (err) {
                console.error(`Error getting contact for welcome mention ${member.id}:`, err);
            }
        }

        // Add specific mentions (always mentioned members)
        let specificMentions = [];
        if (settings.specific_mentions) {
            try {
                specificMentions = JSON.parse(settings.specific_mentions);
            } catch (err) {
                console.error('Error parsing specific mentions:', err);
            }
        }

        // Fetch Contact objects for specific mentions and build their mention text
        const specificMentionContacts = [];
        const specificMentionPhones = [];
        for (const mentionId of specificMentions) {
            try {
                const contact = await userClient.getContactById(mentionId);
                if (contact) {
                    specificMentionContacts.push(contact);
                    mentionContacts.push(contact); // Add to main mentions array

                    // Extract phone number for mention text
                    const phone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || mentionId.split('@')[0]);
                    specificMentionPhones.push(phone);
                    console.log(`✅ Added specific mention: ${contact.pushname || contact.name || phone} (${phone})`);
                }
            } catch (err) {
                console.error(`Error getting specific mention contact ${mentionId}:`, err);
            }
        }

        // Build mention text for new members at the top
        const newMemberMentionText = members.map(m => `@${m.phone}`).join(' ');

        // Build specific mentions text for the bottom
        const specificMentionText = specificMentionPhones.map(phone => `@${phone}`).join(' ');

        console.log(`📝 New members mention text (top): ${newMemberMentionText}`);
        console.log(`📝 Specific mentions text (bottom): ${specificMentionText}`);
        console.log(`📝 Total mention contacts: ${mentionContacts.length}`);

        // Process message text to replace mentions with proper format
        let processedMessageText = settings.message_text;

        // Build full message: new members at top, message text in middle, specific mentions at bottom
        let fullMessage = `${newMemberMentionText}\n\n${processedMessageText}`;
        if (specificMentionText) {
            fullMessage = `${newMemberMentionText}\n\n${processedMessageText}\n\n${specificMentionText}`;
        }

        const messageOptions = {};
        if (mentionContacts.length > 0) {
            messageOptions.mentions = mentionContacts;
        }

        // Send text message
        await chat.sendMessage(fullMessage, messageOptions);
        console.log(`✅ Welcome text message sent to ${groupName}`);

        // Send image message if enabled
        if (settings.image_enabled && settings.image_data) {
            try {
                const imageBuffer = Buffer.from(settings.image_data, 'base64');
                const media = new MessageMedia(settings.image_mimetype, settings.image_data, settings.image_filename);

                // Caption can also have mentions
                let caption = settings.image_caption || '';

                const imageMessageOptions = {};
                if (caption) {
                    imageMessageOptions.caption = caption;
                }
                if (specificMentionContacts.length > 0 && caption) {
                    // If caption has mentions, include them
                    imageMessageOptions.mentions = specificMentionContacts;
                }

                await chat.sendMessage(media, imageMessageOptions);
                console.log(`✅ Welcome image message sent to ${groupName}`);
            } catch (imgErr) {
                console.error('Error sending welcome image:', imgErr);
            }
        }
    } catch (error) {
        console.error('Error sending welcome message:', error);
    }
}

async function createEventForUser(userId, userClient, memberId, eventType, groupName, groupId, messageTimestamp = null) {
    try {
        const contact = await userClient.getContactById(memberId);
        const memberPhone = (contact.id && contact.id.user) ? contact.id.user : (contact.number || memberId.split('@')[0]);
        const memberName = contact.pushname || contact.name || contact.verifiedName || memberPhone;

        // Use message timestamp if provided, otherwise use current time (for real-time events)
        const timestamp = messageTimestamp || new Date();
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
                INSERT OR REPLACE INTO messages (id, group_id, group_name, sender, sender_id, message, timestamp, replied_to_message_id, replied_to_sender, replied_to_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (const msg of processedMessages) {
                insertStmt.run(msg.id, msg.groupId, msg.groupName, msg.sender, msg.senderId, msg.message, msg.timestamp, msg.repliedToMessageId, msg.repliedToSender, msg.repliedToMessage);
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

        // Handle notification messages (joins, leaves, etc.) - including gp2 type
        if (msg.type === 'notification' || msg.type === 'notification_template' || msg.type === 'group_notification' || msg.type === 'gp2') {
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

        // Determine message content based on type
        let body = msg.body;
        if (!body || body.trim() === '') {
            // Handle different media types
            switch (msg.type) {
                case 'ptt':
                case 'audio':
                    body = '[Voice Message]';
                    break;
                case 'image':
                    body = '[Image]';
                    break;
                case 'video':
                    body = '[Video]';
                    break;
                case 'document':
                    body = '[Document]';
                    break;
                case 'sticker':
                    body = '[Sticker]';
                    break;
                default:
                    if (msg.hasMedia) {
                        body = '[Media]';
                    } else {
                        body = '';
                    }
            }
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
// SCHEDULED BROADCAST EXECUTOR
// ============================================

// Function to execute a scheduled broadcast
async function executeScheduledBroadcast(broadcast) {
    const userId = broadcast.user_id;
    const groupIds = JSON.parse(broadcast.group_ids);
    const message = broadcast.message;
    const messageType = broadcast.message_type;
    const pollOptions = broadcast.poll_options ? JSON.parse(broadcast.poll_options) : null;
    const mentions = broadcast.mentions ? JSON.parse(broadcast.mentions) : null;
    const gapTime = broadcast.gap_time || 10;
    const gapTimeMs = gapTime * 1000;
    const allowMultipleAnswers = broadcast.allow_multiple_answers === 1;

    console.log(`📤 Executing scheduled broadcast ${broadcast.id} for user ${userId}`);

    try {
        // Check if user's WhatsApp client is ready
        const userClient = whatsappClients.get(userId);
        if (!userClient || !userClientReady.get(userId)) {
            throw new Error('WhatsApp client not ready');
        }

        const results = [];
        const errors = [];

        // Reconstruct file from base64 if present
        let file = null;
        if (broadcast.file_data && broadcast.file_mimetype && broadcast.file_name) {
            file = {
                buffer: Buffer.from(broadcast.file_data, 'base64'),
                mimetype: broadcast.file_mimetype,
                originalname: broadcast.file_name
            };
        }

        // Send to each group with delay (same logic as immediate broadcast)
        for (let i = 0; i < groupIds.length; i++) {
            const groupId = groupIds[i];

            // Wait before sending to this group (except for the first one)
            if (i > 0) {
                console.log(`⏳ Waiting ${gapTime} seconds before next scheduled broadcast...`);
                await new Promise(resolve => setTimeout(resolve, gapTimeMs));
            }

            try {
                const chat = await userClient.getChatById(groupId);
                if (!chat) {
                    errors.push({ groupId, error: 'Group not found' });
                    continue;
                }

                let sentMessage;

                // Handle different message types
                if (messageType === 'poll' && pollOptions) {
                    if (!pollOptions || pollOptions.length < 2) {
                        errors.push({ groupId, error: 'Poll must have at least 2 options' });
                        continue;
                    }

                    const poll = new Poll(message, pollOptions, { allowMultipleAnswers });
                    sentMessage = await chat.sendMessage(poll);
                } else if (file) {
                    const media = new MessageMedia(
                        file.mimetype,
                        file.buffer.toString('base64'),
                        file.originalname
                    );

                    sentMessage = await chat.sendMessage(media, {
                        caption: message || ''
                    });
                } else if (message && message.trim()) {
                    const messageOptions = {};
                    if (mentions && mentions.length > 0) {
                        // Use mention IDs directly (new whatsapp-web.js format)
                        messageOptions.mentions = mentions;
                    }
                    sentMessage = await chat.sendMessage(message, messageOptions);
                } else {
                    errors.push({ groupId, error: 'Message content or file is required' });
                    continue;
                }

                results.push({
                    groupId,
                    messageId: sentMessage.id._serialized,
                    success: true
                });

                console.log(`✅ Scheduled broadcast sent to group ${groupId}`);
            } catch (error) {
                console.error(`❌ Error sending scheduled broadcast to group ${groupId}:`, error);
                errors.push({ groupId, error: error.message });
            }
        }

        // Update broadcast status and result
        const resultSummary = JSON.stringify({
            totalSent: results.length,
            totalFailed: errors.length,
            results,
            errors
        });

        db.run(`
            UPDATE scheduled_broadcasts
            SET status = ?, executed_at = ?, result_summary = ?
            WHERE id = ?
        `, ['sent', new Date().toISOString(), resultSummary, broadcast.id], (err) => {
            if (err) {
                console.error('Error updating broadcast status:', err);
            } else {
                console.log(`✅ Scheduled broadcast ${broadcast.id} completed: ${results.length} sent, ${errors.length} failed`);
            }
        });

    } catch (error) {
        console.error(`❌ Error executing scheduled broadcast ${broadcast.id}:`, error);

        // Mark as failed
        const resultSummary = JSON.stringify({
            error: error.message,
            totalSent: 0,
            totalFailed: 0
        });

        db.run(`
            UPDATE scheduled_broadcasts
            SET status = ?, executed_at = ?, result_summary = ?
            WHERE id = ?
        `, ['failed', new Date().toISOString(), resultSummary, broadcast.id]);
    }
}

// Check for scheduled broadcasts every minute
schedule.scheduleJob('* * * * *', async () => {
    const now = new Date().toISOString();

    db.all(`
        SELECT *
        FROM scheduled_broadcasts
        WHERE status = 'pending' AND scheduled_time <= ?
        ORDER BY scheduled_time ASC
    `, [now], async (err, broadcasts) => {
        if (err) {
            console.error('Error fetching scheduled broadcasts:', err);
            return;
        }

        if (broadcasts && broadcasts.length > 0) {
            console.log(`📅 Found ${broadcasts.length} scheduled broadcast(s) to execute`);

            // Execute each broadcast
            for (const broadcast of broadcasts) {
                // Mark as executing to prevent duplicate execution
                db.run(`
                    UPDATE scheduled_broadcasts
                    SET status = 'executing'
                    WHERE id = ?
                `, [broadcast.id]);

                // Execute in background (don't await to allow parallel execution)
                executeScheduledBroadcast(broadcast).catch(err => {
                    console.error(`Error in scheduled broadcast ${broadcast.id}:`, err);
                });
            }
        }
    });
});

console.log('⏰ Scheduled broadcast checker initialized (runs every minute)');

// ============================================
// ADMIN-ONLY MODE SCHEDULER
// ============================================

// Function to check and apply admin-only mode schedules
async function checkAndApplyAdminOnlySchedules() {
    try {
        // Get current time in Egypt timezone (UTC+2)
        const now = new Date();
        const egyptTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
        const currentTime = `${String(egyptTime.getHours()).padStart(2, '0')}:${String(egyptTime.getMinutes()).padStart(2, '0')}`;

        console.log(`⏰ [Admin-Only Scheduler] Checking at ${currentTime} (Egypt Time)...`);

        // Get all enabled schedules from database
        db.all(`
            SELECT * FROM admin_only_schedule WHERE enabled = 1
        `, async (err, schedules) => {
            if (err) {
                console.error('❌ [Admin-Only Scheduler] Error fetching schedules:', err);
                return;
            }

            if (!schedules || schedules.length === 0) {
                console.log(`ℹ️  [Admin-Only Scheduler] No enabled schedules found`);
                return;
            }

            console.log(`📋 [Admin-Only Scheduler] Found ${schedules.length} enabled schedule(s)`);

            for (const schedule of schedules) {
                const userId = schedule.user_id;
                const groupId = schedule.group_id;
                const openTime = schedule.open_time;
                const closeTime = schedule.close_time;

                console.log(`  📌 Schedule for User ${userId}, Group ${groupId}:`);
                console.log(`     Open: ${openTime}, Close: ${closeTime}, Current: ${currentTime}`);

                // Get user's WhatsApp client
                const userClient = whatsappClients.get(userId);
                const clientReady = userClientReady.get(userId);

                if (!userClient) {
                    console.log(`  ⚠️  User ${userId} - WhatsApp client not found`);
                    continue;
                }

                if (!clientReady) {
                    console.log(`  ⚠️  User ${userId} - WhatsApp client not ready`);
                    continue;
                }

                try {
                    const chat = await userClient.getChatById(groupId);
                    if (!chat) {
                        console.log(`  ⚠️  Chat not found for user ${userId}, group ${groupId}`);
                        continue;
                    }

                    // Check if it's time to open (everyone can send)
                    if (currentTime === openTime) {
                        console.log(`  🔓 OPENING chat for user ${userId}, group ${groupId} at ${currentTime}`);
                        await chat.setMessagesAdminsOnly(false);
                        console.log(`  ✅ Chat opened - everyone can send messages`);
                    }

                    // Check if it's time to close (admins only)
                    if (currentTime === closeTime) {
                        console.log(`  🔒 CLOSING chat for user ${userId}, group ${groupId} at ${currentTime}`);
                        await chat.setMessagesAdminsOnly(true);
                        console.log(`  ✅ Chat closed - only admins can send messages`);
                    }
                } catch (error) {
                    console.error(`  ❌ Error applying admin-only mode for user ${userId}, group ${groupId}:`, error);
                }
            }
        });
    } catch (error) {
        console.error('❌ [Admin-Only Scheduler] Error in scheduler:', error);
    }
}

// Start the scheduler - check every minute
let adminOnlySchedulerInterval;

function startAdminOnlyScheduler() {
    // Check immediately on start
    checkAndApplyAdminOnlySchedules();

    // Then check every minute
    adminOnlySchedulerInterval = setInterval(() => {
        checkAndApplyAdminOnlySchedules();
    }, 60 * 1000); // 60 seconds

    console.log('⏰ Admin-only mode scheduler started (checks every minute)');
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

    // Start the admin-only mode scheduler
    startAdminOnlyScheduler();

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
