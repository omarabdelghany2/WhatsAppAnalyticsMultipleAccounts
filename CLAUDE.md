# CLAUDE.md

This file provides comprehensive guidance to Claude Code when working with the WhatsApp Analytics codebase.

## Project Overview

WhatsApp Analytics is a full-stack multi-tenant application that monitors WhatsApp groups and provides real-time analytics dashboard. Multiple users can register, authenticate with their own WhatsApp accounts via QR code, monitor different groups, and view analytics. Admins can manage users and view all user data. The backend (Node.js + Express) connects to WhatsApp Web using whatsapp-web.js, stores data in SQLite, and exposes REST API endpoints with WebSocket real-time updates. The frontend (React + TypeScript + Vite) is a single-page application with authentication, multi-tenant support, and admin dashboard.

## Architecture Deep Dive

### Backend Architecture (server.js)

**Initialization Flow (lines 1-370):**
- Express app with CORS enabled
- WebSocket server setup with explicit upgrade handler (lines 25-40) for Railway compatibility
- Frontend static file serving in production (lines 45-52)
- Data directory management (lines 54-63): `/app/data` on Railway, local project root in development
- JWT authentication setup (lines 65-91): 1-day token expiration, `authenticateToken` and `authenticateAdmin` middleware
- Config loading from persistent storage (lines 116-137): groups, checkInterval, messageLimit, detectJoinsLeaves, port

**Database Schema (lines 159-323):**
The SQLite database has 6 main tables, all with automatic migrations on startup:

1. **users** - Multi-tenant user accounts
   - id (PRIMARY KEY)
   - username, email (UNIQUE)
   - password_hash (bcrypt)
   - is_admin, whatsapp_authenticated (boolean flags)
   - created_at
   - Indexes: email, username

2. **whatsapp_sessions** - Maps users to WhatsApp clients
   - id, user_id (FOREIGN KEY)
   - session_id (UNIQUE), phone_number
   - is_authenticated, last_connected
   - Indexes: user_id, session_id

3. **messages** - All group messages
   - id (TEXT PRIMARY KEY: msg.id._serialized)
   - user_id, group_id, group_name
   - sender, sender_id, message, timestamp
   - Indexes: user_id, group_id, timestamp DESC

4. **events** - JOIN/LEAVE/CERTIFICATE events
   - id (AUTOINCREMENT)
   - user_id, group_id, group_name
   - member_id (phone number), member_name, type (JOIN/LEAVE/CERTIFICATE)
   - timestamp, date (YYYY-MM-DD)
   - Indexes: user_id, group_id, timestamp DESC, date DESC, date+member_id

5. **monitored_groups** - Which groups each user monitors
   - id, user_id (FOREIGN KEY), group_id, group_name
   - added_at
   - UNIQUE(user_id, group_id)
   - Indexes: user_id, group_id

6. **whatsapp_sessions** - Per-user WhatsApp session tracking
   - Stores phone_number, auth status, last_connected

**In-Memory Data Structures (lines 325-358):**
```javascript
groupInfoStore = new Map()  // groupId -> {name, id, memberCount}
groupMembersCache = new Map()  // groupId -> Map(memberId -> {name, phone, isAdmin})
whatsappClients = new Map()  // userId -> WhatsAppClient instance
userMonitoredGroups = new Map()  // userId -> Map(groupId -> {name, id, previousMessageIds, previousMembers, isFirstRun})
userClientReady = new Map()  // userId -> boolean
userQRCodes = new Map()  // userId -> qrCodeString
userAuthStatus = new Map()  // userId -> 'initializing'|'qr_ready'|'authenticating'|'authenticated'
userMonitoringIntervals = new Map()  // userId -> interval ID
wsClients = new Set()  // Connected WebSocket clients
```

### API Endpoints (370-1700 lines)

**Authentication Endpoints:**
- `POST /api/auth/register` - Register new user with username, email, password; generates JWT token
- `POST /api/auth/login` - Login with email, password; returns JWT token and user object
- `GET /api/auth/me` - Get current user (requires JWT); used for token validation on app load
- `POST /api/admin/make-me-admin` - One-time endpoint to promote first user to admin
- `PUT /api/admin/users/:userId/admin` - Grant/revoke admin privileges (admin only)

**WhatsApp Connection Endpoints:**
- `POST /api/whatsapp/init` - Initialize WhatsApp client for logged-in user; creates QR code and starts client
- `GET /api/whatsapp/qr` - Fetch current QR code for user (polls until authenticated)
- `GET /api/whatsapp/status` - Check if user's WhatsApp is authenticated
- `POST /api/whatsapp/logout` - Logout user from WhatsApp; destroys client and clears session

**Groups Endpoints:**
- `GET /api/groups` - List user's monitored groups (from userMonitoredGroups)
- `POST /api/groups` - Add new group by name; searches WhatsApp chats, creates monitored_groups entry
- `DELETE /api/groups/:groupId` - Stop monitoring group (removes from monitored_groups)
- `GET /api/groups/:groupId/members` - Get all members of a group with phone numbers and admin status

**Messages Endpoints:**
- `GET /api/messages` - Get all messages for user (paginated, sorted by timestamp DESC)
- `GET /api/messages/:groupId` - Get messages from specific group for user
- `GET /api/search?q=query&groupId=optional` - Full-text search messages (case-insensitive LIKE)

**Events Endpoints:**
- `GET /api/events?limit=100&offset=0&date=YYYY-MM-DD&memberId=optional` - Get events with date/member filtering
  - Date formats: single date (YYYY-MM-DD) or range (YYYY-MM-DD,YYYY-MM-DD)
  - Returns: events array with total count and pagination info
- `GET /api/events/:groupId` - Get events from specific group

**Stats Endpoints:**
- `GET /api/stats?date=optional` - Get statistics: totalMessages, totalEvents, totalJoins, totalLeaves, totalCertificates, activeUsers, topSenders, dailyActivity
- `GET /api/admin/view-user/:userId/stats` - Get stats for specific user (admin only)

**Admin Data View Endpoints (admin only):**
- `GET /api/admin/users` - List all users with admin status and WhatsApp auth status
- `GET /api/admin/view-user/:userId/groups` - View specific user's monitored groups
- `GET /api/admin/view-user/:userId/messages` - View all messages of specific user
- `GET /api/admin/view-user/:userId/messages/:groupId` - View messages in specific group for specific user
- `GET /api/admin/view-user/:userId/events` - View events for specific user
- `GET /api/admin/view-user/:userId/groups/:groupId/members` - View group members as another user

### WhatsApp Client Initialization (lines 2033-2410)

**Multi-Client Architecture:**
- Each user gets their own WhatsApp client instance (lines 2267-2486)
- Clients stored in `whatsappClients` Map keyed by userId
- Per-user auth status tracking via `userAuthStatus` Map

**Client Setup Steps (initializeWhatsAppClient, lines 2267-2486):**
1. Find Chromium executable from Nix store (Railway) or use system default (lines 2034-2053)
2. Configure Puppeteer headless browser with sandbox disabled and GPU disabled (lines 2057-2076)
3. Clean up stale Chromium lock files (lines 2282-2319) - prevents crashes on Railway restarts
4. Create Client with LocalAuth strategy (lines 2321-2327) using `user_${userId}` clientId
5. Register event listeners (lines 2334-2477):
   - `qr`: Generate QR code, broadcast via WebSocket (lines 2334-2347)
   - `authenticated`: Mark as authenticated in database (lines 2349-2366)
   - `ready`: Client fully initialized, cache group members, start monitoring (lines 2368-2410)
   - `auth_failure`: Handle authentication failure (lines 2413-2422)
   - `group_join`: Real-time group join event (lines 2425-2440)
   - `group_leave`: Real-time group leave event (lines 2443-2458)
   - `disconnected`: Handle disconnection (lines 2460-2477)
6. Call `userClient.initialize()` to start the flow (line 2483)

**Group Initialization (initializeGroupsForUser, lines 2525-2588):**
- Load user's monitored groups from `monitored_groups` table
- For each saved group, find it in WhatsApp chats
- Initialize group state: previousMessageIds Set, previousMembers Set, isFirstRun=true
- Cache group members for fast lookup (lines 2577, 2645-2686)

**Member Caching (cacheGroupMembersForUser, lines 2645-2686):**
- For each group participant, fetch contact details
- Extract phone number: `contact.id.user` → fallback `contact.number` → fallback `participant.id.user`
- Extract display name: `contact.pushname` → `contact.name` → `contact.verifiedName` → phone number
- Store in `groupMembersCache[groupId]` Map with senderId as key
- Enables fast message author resolution without repeated API calls

### Monitoring System (lines 2688-2840)

**Per-User Monitoring (startMonitoringForUser, lines 2695-2840):**
- Each user has their own interval (stored in `userMonitoringIntervals`)
- Polling interval configurable via `CHECK_INTERVAL` (default 15 seconds)
- For each user's monitored groups, call `checkMessagesForUser`

**Message Detection (checkMessagesForUser, lines 2738-2840):**
1. Fetch latest N messages from WhatsApp (configurable limit, default 15)
2. Track seen message IDs to detect new ones (lines 2768-2785)
3. Clean up old IDs to prevent memory bloat (max 100 tracked per group)
4. Process new messages (see processMessageForUser below)
5. Save to database with INSERT OR REPLACE (lines 2803-2813)
6. Broadcast new messages via WebSocket (lines 2815-2825)

### Message Processing (processMessageForUser, lines 2842-2988)

**Notification Messages (lines 2851-2911):**
- Detect message type: 'notification', 'notification_template', 'group_notification', 'gp2'
- Extract event type from notification subtype:
  - 'add'/'invite'/'group_invite_link' → JOIN event
  - 'remove'/'leave' → LEAVE event
- Resolve member ID from `msg.recipientIds[0]`
- Fetch contact to get phone number and display name
- Create JOIN/LEAVE event in database (via createEventForUser)
- Return notification as a system message for display

**Regular Messages (lines 2914-2987):**
- Get message sender via `msg.getContact()`
- Extract sender ID (_serialized format) and phone number
- Resolve sender name from contact (pushname → name → verifiedName → phone → ID)
- Check if voice/audio (ptt) → create CERTIFICATE event (one per member per day)
- Determine message content based on type:
  - Text: use msg.body
  - Voice/audio: '[Voice Message]'
  - Image: '[Image]'
  - Video: '[Video]'
  - Document: '[Document]'
  - Sticker: '[Sticker]'
  - Other: '[Media]'
- Return structured message object for database storage

**Event Creation (createEventForUser, lines 2990-3043):**
- Get member contact details
- Use message timestamp if available, else current time
- Extract date as YYYY-MM-DD
- For JOIN/LEAVE: Delete previous events of same type for member (prevents duplicates)
- For CERTIFICATE: Check if already exists for today (one per day limit)
- Insert into events table
- Return event object for broadcasting

### WebSocket Real-Time Updates (lines 1997-2027)

**Connection Handler (lines 1997-2017):**
- Store new client in `wsClients` Set
- Send initial connection message with current group info
- Register close handler to remove from Set
- Register error handler

**Broadcasting (lines 2020-2027):**
```javascript
function broadcast(data) {
    const message = JSON.stringify(data);
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}
```
- Broadcasts message types: 'message', 'event', 'qr', 'authenticated', 'ready', 'auth_failure', 'disconnected'
- Includes userId for multi-tenant message filtering on client side

### Production Mode (lines 3448-3461)

- When `NODE_ENV=production` or `RAILWAY_ENVIRONMENT` is set:
  - Serve frontend static files from `frontend/dist` (lines 45-52)
  - Implement SPA routing catch-all: any non-API route returns index.html (lines 3453-3461)
  - Enables single-page application navigation

---

### Frontend Architecture (React + TypeScript + Vite)

**Routing Structure (frontend/src/App.tsx):**
```
/login - Public login page (Register.tsx)
/register - Public registration page
/whatsapp-connect - Protected, WhatsApp QR scanning (WhatsAppConnect.tsx)
/ - Protected, main dashboard (Index.tsx)
/dashboard - Protected + Admin-only, user management (Dashboard.tsx)
/dashboard/view/:userId - Protected + Admin-only, view specific user data (AdminUserView.tsx)
* - Catch-all NotFound page
```

**Auth Context (frontend/src/contexts/AuthContext.tsx):**
- Stores: user object (id, username, email, isAdmin), JWT token, isLoading flag
- On mount: validates token via GET `/api/auth/me`
- Login/register methods: make API call, store token and user in state + localStorage
- Logout: clear state and localStorage
- `isAdmin` helper: returns user?.isAdmin || false

**Protected Routes:**
- `ProtectedRoute` (components/ProtectedRoute.tsx): Requires valid auth; redirects to /login if not
- `AdminRoute` (components/AdminRoute.tsx): Requires admin role; redirects to / if not admin

**Main Dashboard (pages/Index.tsx):**
- Query hooks for:
  - Groups: `useQuery(['groups'])` fetches `api.getGroups()` with 30s refetch interval
  - All Messages: `useQuery(['all-messages'])` fetches recent 100 messages
  - Selected Group Messages: `useQuery(['group-messages', selectedGroupId])` fetches up to 1000 messages
  - Events: `useQuery(['events', selectedDate])` fetches all events, filterable by date and member
- Admin mode: Prepends 'admin-view-' to query keys, uses admin endpoints (api.viewUserGroups, api.viewUserMessages, etc.)
- WebSocket listener: `wsClient.subscribe('message')` and `wsClient.subscribe('event')` for real-time updates
- Translation mode: Toggle to show Google Translate button on each message
- Components: GroupList (sidebar), ChatView (main chat), AnalyticsPanel (statistics)

**Group List Component (components/GroupList.tsx):**
- Displays user's monitored groups as clickable items
- Shows preview of latest 2 messages per group
- Highlight selected group
- Add/remove group buttons

**Chat View Component (components/ChatView.tsx):**
- Displays messages in chronological order (newest at bottom)
- Auto-scroll only if user was already at bottom (prevents scroll jumping)
- Per-message translate button (calls `/api/translate-message` via Google Translate API)
- Caches translations in state (Map<messageId, translatedText>)

**Analytics Panel Component (components/AnalyticsPanel.tsx):**
- Shows statistics: totalMembers, joined, left, messageCount, activeUsers, certificates
- Date filter modes:
  - "all": All events
  - "specific": Single date (calendar picker)
  - "period": Date range (start/end calendar pickers)
- Event dialogs: Click card to see JOIN/LEAVE/CERTIFICATE events for the period
- Members dialog: Click "Total Members" to see group members with admin status
- Export to Excel: Uses ExcelJS library to create .xlsx file

**Admin Dashboard (pages/Dashboard.tsx):**
- Fetch all users via `api.getUsers()`
- Display users in table: username, email, admin status (toggle switch)
- Toggle user admin status via `api.updateUserAdmin(userId, isAdmin)`
- View user button: Navigate to `/dashboard/view/{userId}`

**Admin User View (pages/AdminUserView.tsx):**
- Similar to Index.tsx but for a specific user
- Uses admin endpoints: `api.viewUserGroups(userId)`, `api.viewUserMessages(userId, ...)`, etc.
- Same structure: GroupList, ChatView, AnalyticsPanel
- Back button to return to dashboard

### API Client (frontend/src/lib/api.ts)

**REST API Methods:**
- Auth: `login(email, password)`, `register(username, email, password)`, `getAuthStatus()`
- Groups: `getGroups()`, `addGroup(name)`, `deleteGroup(groupId)`, `getGroupMembers(groupId)`
- Messages: `getMessages(limit, offset)`, `getMessagesByGroup(groupId, limit, offset)`, `searchMessages(query, groupId, limit)`
- Events: `getEvents(limit, offset, date, memberId)`, `getEventsByGroup(groupId, limit, offset)`
- Stats: `getStats(date)`
- Admin: `getUsers()`, `updateUserAdmin(userId, isAdmin)`, `makeMeAdmin()`
- Admin View: `viewUserGroups(userId)`, `viewUserMessages(userId, ...)`, `viewUserEvents(userId, ...)`, `viewUserStats(userId, ...)`

**Request Headers:**
- All requests include Bearer token from localStorage
- Content-Type: application/json

**WebSocket Client (WSClient class, lines 230-270):**
```javascript
class WSClient {
    connect() - Establish WebSocket connection to WS_URL
    reconnectAttempts - Max 3 attempts before falling back to polling
    listeners - Map<eventType, Set<callback>>
    subscribe(eventType, callback) - Register listener
    send(data) - Send message to server
}
```
- Auto-reconnects on disconnect (up to 3 times)
- Falls back to polling if WebSocket unavailable
- Event types: 'message', 'event', 'qr', 'authenticated', 'ready', 'auth_failure', 'disconnected'

---

## Data Flow Diagrams

### User Authentication Flow
```
User Registration → POST /api/auth/register (email, password)
    ↓
Backend: Hash password with bcrypt, create users table entry
    ↓
Generate JWT token (exp: 1 day)
    ↓
Return token + user object to frontend
    ↓
Frontend: Store token in localStorage, set AuthContext
    ↓
Ready for WhatsApp connection
```

### WhatsApp Connection Flow
```
User clicks "Connect WhatsApp" → POST /api/whatsapp/init
    ↓
Backend: Create WhatsAppClient instance for user
    ↓
Client generates QR code → broadcast via WebSocket to user
    ↓
Frontend: Display QR code in <QRCode> component
    ↓
User scans with WhatsApp
    ↓
Backend: 'authenticated' event fires → 'ready' event fires
    ↓
Backend: Load monitored_groups from database
    ↓
Backend: Start per-user monitoring loop
    ↓
Frontend: Redirect to dashboard
```

### Message Capture & Storage Flow
```
WhatsApp group receives message
    ↓
Backend: checkMessagesForUser polling loop (every 15s)
    ↓
Fetch latest N messages from WhatsApp
    ↓
Compare with previousMessageIds to find new messages
    ↓
For each new message: processMessageForUser()
    ↓
Extract sender info, resolve display name from contacts
    ↓
Check message type (notification, ptt, image, text, etc.)
    ↓
If notification: Parse subtype → create JOIN/LEAVE event
    ↓
If voice/audio: Create CERTIFICATE event
    ↓
Insert message into messages table (or events table if event)
    ↓
broadcast() → Send via WebSocket to all connected clients
    ↓
Frontend WSClient listener → Update component state → Re-render
```

### Event Detection (JOIN/LEAVE/CERTIFICATE)
```
Message Processing:
  - Notification with subtype 'add'/'invite' → JOIN event
  - Notification with subtype 'remove'/'leave' → LEAVE event
  - Message type 'ptt' or 'audio' → CERTIFICATE event (one per member per day)

Real-time Events:
  - 'group_join' event handler → createEventForUser with eventType='JOIN'
  - 'group_leave' event handler → createEventForUser with eventType='LEAVE'

Event Storage:
  - Delete previous events of same type for same member (for JOIN/LEAVE)
  - Check if CERTIFICATE already exists for today (one per day limit)
  - Insert into events table with user_id, group_id, member_id, type, timestamp, date
```

---

## Key Technical Details

### JWT Authentication Mechanism
- Secret: `process.env.JWT_SECRET` (or hardcoded default for dev)
- Token format: `Bearer <token>` in Authorization header
- Payload includes: userId, username, email
- Expiration: 1 day (JWT_EXPIRES_IN = '1d')
- Verification: `jwt.verify(token, JWT_SECRET)` on each protected route
- Middleware `authenticateToken` returns 401 if token missing, 403 if invalid/expired

### Admin Privilege System
- Added column `is_admin BOOLEAN DEFAULT 0` to users table
- Admin endpoints protected by `authenticateAdmin` middleware
- Admin checks: `db.get('SELECT is_admin FROM users WHERE id = ?')`
- Admins can:
  - View all users and their admin status
  - Grant/revoke admin privileges to other users
  - View any user's groups, messages, events, stats
  - View group members as another user

### Multi-Tenant Data Isolation
- Each user's data filtered by `user_id` in messages and events tables
- Groups stored in `monitored_groups` table linking user_id + group_id
- WhatsApp clients isolated per-user in `whatsappClients` Map
- In-memory structures (monitoredGroups, groupMembersCache) shared but filtered by userId at API response level
- Admin endpoints explicitly query for specific userId

### Database Query Patterns
- **Parameterized queries**: Always use `?` placeholders to prevent SQL injection
- **Timestamp storage**: ISO 8601 format (e.g., "2024-12-10T14:30:00.000Z")
- **Date field**: Separate YYYY-MM-DD field for efficient date range queries
- **Pagination**: LIMIT + OFFSET pattern, return total count separately
- **Indexes**: On frequently queried columns (timestamp DESC, date DESC, user_id, group_id)

### Member Phone Number Resolution
- WhatsApp stores member ID in format: `12025551234@c.us` (country code + number + suffix)
- Extraction logic:
  1. Try `contact.id.user` (most reliable)
  2. Fallback to `contact.number`
  3. Fallback to `msg.recipientIds[0]` split on '@'
- Display format: "Name (PhoneNumber)" or just phone if name unavailable
- Stored in events table as `member_id` for grouping and filtering

### Voice Message (Certificate) Event
- Detected by message type: `msg.type === 'ptt'` or `msg.type === 'audio'`
- One CERTIFICATE per member per day (daily limit enforced in database query)
- Timestamp set to message timestamp (not current time)
- Used for tracking participation in voice-based discussions
- Useful for certifying daily attendance or participation

### WebSocket Message Broadcasting
- Broadcasts to ALL connected clients (no filtering by userId)
- Frontend filters by userId in message listeners (if needed in future)
- Message types carry userId if needed: `{type: 'event', userId: 123, event: {...}}`
- Current implementation broadcasts to all; could be optimized for per-user rooms

### Railway-Specific Configuration
- `DATA_DIR = '/app/data'` for persistent database storage (mounted volume)
- Chromium detection from Nix store (lines 2039-2045)
- Lock file cleanup to prevent Chromium crashes (lines 2282-2319)
- Frontend served from `frontend/dist` (built during deploy)
- Environment variable `RAILWAY_ENVIRONMENT` triggers production mode detection

### Error Handling Patterns
- API endpoints return `{success: false, error: 'message'}` on failure
- Database errors: Try-catch or callback error parameter
- WhatsApp client errors: Event handlers (auth_failure, disconnected)
- Frontend: Check `response.success` before using data

---

## Common Development Tasks

### Adding a New Event Type (e.g., STICKER)
1. Add detection logic in `processMessageForUser` (after CERTIFICATE check)
   ```javascript
   if (msg.type === 'sticker') {
       const event = await createEventForUser(userId, userClient, senderId, 'STICKER', groupName, groupId, timestamp);
   }
   ```
2. Update Event interface in `frontend/src/lib/api.ts` to include new type
3. Update event filtering logic in `AnalyticsPanel.tsx`
4. Update stats query to count new event type

### Changing Message Polling Interval
1. Modify `CHECK_INTERVAL` config value (lines 141)
2. Set in `config.json`: `"checkInterval": 30000` (30 seconds)
3. Used in monitoring loop at lines 2710-2720

### Adding New Admin Endpoint
1. Create new `app.get/post/put/delete` handler
2. Add `authenticateToken, authenticateAdmin` middleware
3. Query database with specific userId from params
4. Return filtered data
5. Document in API Endpoints section

### Debugging Message Processing
1. Uncomment debug logs in `processMessageForUser` (line 2848)
2. Watch console for message types, subtypes, sender names
3. Check `groupMembersCache` contents in memory
4. Verify timestamp resolution and date extraction
5. Test notification parsing with actual WhatsApp messages

### Testing WebSocket Connection
1. Open browser DevTools → Network tab → WS filter
2. Look for connection to `ws://localhost:3000` or `wss://domain/ws`
3. Watch for incoming messages in message log
4. Check message format: `{type: 'message'|'event', ...}`
5. Frontend should automatically reconnect on disconnect (up to 3 times)

### Database Inspection
1. Use SQLite CLI: `sqlite3 whatsapp_analytics.db`
2. Common queries:
   ```sql
   -- View all users
   SELECT id, username, email, is_admin, whatsapp_authenticated FROM users;
   
   -- View messages for specific user
   SELECT sender, message, timestamp FROM messages WHERE user_id = 1 LIMIT 10;
   
   -- View events for specific user and date
   SELECT member_name, type, timestamp FROM events WHERE user_id = 1 AND date = '2024-12-10';
   
   -- View group membership
   SELECT user_id, group_name FROM monitored_groups WHERE user_id = 1;
   ```

---

## Important Notes & Gotchas

1. **First-time Setup**: Must initialize WhatsApp client BEFORE monitoring can start. Navigate to `/whatsapp-connect`, scan QR code, wait for client ready.

2. **Session Persistence**: WhatsApp session stored in `.wwebjs_auth/user_<userId>` directory. Deleting this requires re-scanning QR code.

3. **Data Persistence**: Messages and events survive server restarts (stored in SQLite). On Railway, uses persistent volume at `/app/data`.

4. **Group Detection**: Backend searches for groups using case-insensitive substring matching. Group name in config must match (partially) the WhatsApp group name.

5. **Member Name Resolution**: Relies on WhatsApp contacts cache. If contact info unavailable, falls back to phone number extraction.

6. **Certificate Daily Limit**: Only one CERTIFICATE event per member per day (enforced at database level). Prevents duplicate entries for multiple voice messages same day.

7. **Message Limit**: Fetches only last N messages per check (default 15, configurable). For first run or after long gaps, still captures history within limit.

8. **WebSocket Fallback**: If WebSocket unavailable, frontend falls back to periodic HTTP polling (every few seconds). Less efficient but ensures real-time updates.

9. **Production Mode**: When `RAILWAY_ENVIRONMENT` is set, backend switches to production: serves frontend from dist/, enables SPA routing, handles WebSocket upgrade explicitly.

10. **Chromium Lock Files**: Railway can leave stale Chromium lock files after crashes. Code cleans these up on client initialization (lines 2282-2319).

11. **JWT Secret**: Use strong random value in production. Default dev secret is weak; set `JWT_SECRET` environment variable.

12. **Database Indexes**: Added for user_id, group_id, timestamp on messages and events. Essential for query performance with large datasets.

13. **Multi-user Race Conditions**: WhatsApp client operations (getting chats, members, messages) are per-user but share global groupMembersCache. Cache is keyed by groupId only (not userId), so member info is shared across users for same group (correct behavior).

14. **Admin Data Leakage**: Admin endpoints must validate admin status on every request. Never cache admin status in frontend to prevent privilege escalation.

15. **Message Type Detection**: Different message types require different handling (notification, ptt, audio, image, video, document, sticker). Unknown types default to '[Media]' placeholder.
