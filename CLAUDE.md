# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp Analytics is a full-stack application that monitors WhatsApp groups and provides real-time analytics. The backend connects to WhatsApp Web using whatsapp-web.js, monitors configured groups, stores messages and events in SQLite, and exposes a REST API with WebSocket support. The frontend is a React/TypeScript SPA built with Vite that displays messages, analytics, and handles authentication.

## Architecture

### Backend (Node.js + Express)
- **server.js**: Main API server that handles WhatsApp client initialization, group monitoring, REST endpoints, and WebSocket broadcasting
- **Data Storage**: SQLite database (whatsapp_analytics.db) with two main tables:
  - `messages`: Stores all group messages with sender, content, timestamps
  - `events`: Tracks JOIN/LEAVE/CERTIFICATE events (voice recordings count as certificates)
- **WhatsApp Integration**: Uses whatsapp-web.js with LocalAuth for persistent sessions stored in `.wwebjs_auth`
- **Monitoring Loop**: Checks groups every 60 seconds (configurable), detects new messages and member changes
- **Real-time**: WebSocket server broadcasts new messages and events to connected clients

### Frontend (React + TypeScript + Vite)
- **Pages**: Login page (QR code scanning) and Index page (main dashboard)
- **Components**: GroupList, ChatView, AnalyticsPanel
- **API Client** (frontend/src/lib/api.ts): Wraps all backend API calls and WebSocket connection
- **WebSocket Client**: Auto-reconnects up to 3 times, falls back to HTTP polling if unavailable

### Data Flow
1. WhatsApp groups → Backend monitors every 60s → Stores in SQLite
2. New data → WebSocket broadcast → Frontend updates in real-time
3. Frontend can also poll via REST API for historical data with pagination

## Development Commands

### Backend
```bash
npm install                    # Install backend dependencies
npm run server                 # Start API server (localhost:3000)
npm run dev                    # Start with nodemon for auto-reload
```

### Frontend
```bash
cd frontend
npm install                    # Install frontend dependencies
npm run dev                    # Start Vite dev server (localhost:5173)
npm run build                  # Build for production
```

### Full Stack Development
Terminal 1: `npm run server` (backend on :3000)
Terminal 2: `cd frontend && npm run dev` (frontend on :5173)

### Railway Deployment
```bash
npm run railway:build         # Build frontend for production
npm run railway:start         # Start server (serves frontend from dist/)
```

## Configuration

### config.json (Backend)
```json
{
  "groups": ["Army", "Family"],    // Group names to monitor
  "checkInterval": 60000,           // Polling interval in ms
  "messageLimit": 15,               // Messages fetched per check
  "detectJoinsLeaves": true,        // Track membership changes
  "port": 3000                      // API server port
}
```

### Environment Variables
- `NODE_ENV`: Set to 'production' for production mode
- `RAILWAY_ENVIRONMENT`: Detected automatically on Railway
- `DATA_DIR`: Database and session storage location
  - Local: Uses project root
  - Railway: Uses `/app/data` (persistent volume)

## Key Technical Details

### Authentication Flow
1. First run: Display QR code (via terminal or `/api/auth/qr` endpoint)
2. User scans with WhatsApp → Client authenticates → Session saved to `.wwebjs_auth`
3. Subsequent runs: Auto-login using saved session (no QR needed)
4. Logout: POST `/api/auth/logout` clears database, config, and session files

### Event Types
- **JOIN**: Member added to group (detected via notifications or real-time events)
- **LEAVE**: Member removed/left group
- **CERTIFICATE**: Voice message (ptt/audio) recorded - one per member per day

### Database Schema
The SQLite database automatically handles migrations. Key indexes:
- Messages: Indexed by group_id and timestamp (DESC)
- Events: Indexed by group_id, timestamp (DESC), date (DESC), and date+member_id

### WebSocket Upgrade Handling
Railway/Nixpacks compatibility: WebSocket upgrade happens on `/ws` path, handled explicitly in server.on('upgrade') to avoid reverse proxy issues.

### Chromium on Railway
The server detects and uses Chromium from Nix store when running on Railway/Nixpacks. Cleans up stale SingletonLock files to prevent crashes after restarts.

## API Endpoints

**Authentication:**
- GET `/api/auth/status` - Check if WhatsApp is authenticated
- GET `/api/auth/qr` - Get QR code for scanning
- POST `/api/auth/logout` - Logout and clear all data

**Groups:**
- GET `/api/groups` - List monitored groups
- POST `/api/groups` - Add new group to monitoring (body: `{name: string}`)
- DELETE `/api/groups/:groupId` - Stop monitoring a group

**Messages:**
- GET `/api/messages?limit=100&offset=0` - Get all messages (paginated)
- GET `/api/messages/:groupId` - Get messages from specific group
- GET `/api/search?q=query&groupId=optional` - Search messages

**Events:**
- GET `/api/events?limit=100&offset=0&date=YYYY-MM-DD&memberId=optional` - Get events (supports date ranges: YYYY-MM-DD,YYYY-MM-DD)
- GET `/api/events/:groupId` - Get events from specific group

**Stats:**
- GET `/api/stats` - Get statistics (message counts, top senders, etc.)

**Health:**
- GET `/api/health` - Server status and WhatsApp connection state

**WebSocket:** Connect to `ws://localhost:3000` (or `wss://domain/ws` in production)

## Common Tasks

### Adding support for a new group
The backend config.json lists group names to monitor. Users can also add groups via POST `/api/groups` which searches WhatsApp chats, adds to monitoring, and updates config.json automatically.

### Modifying message processing
Edit `processMessage()` function in server.js:1239. This handles both regular messages and notifications (joins/leaves). Voice messages (ptt/audio) trigger CERTIFICATE events.

### Changing monitoring interval
Update `checkInterval` in config.json (milliseconds). Default is 60000 (60 seconds).

### Working with the database
SQLite queries are in server.js API endpoints (lines 180-682). Database is auto-initialized on startup with tables and indexes. Use parameterized queries to prevent SQL injection.

### Frontend API integration
All API calls go through frontend/src/lib/api.ts. The WSClient class handles WebSocket connections with auto-reconnect and fallback to polling. Import `api` and `wsClient` from this file.

## Important Notes

- **First-time setup**: Run backend first, scan QR code, then start frontend
- **Data persistence**: Messages/events stored in SQLite (survives restarts). On Railway, database is stored on persistent volume at `/app/data`
- **Session persistence**: WhatsApp session saved in `.wwebjs_auth` directory (also on volume for Railway)
- **Group detection**: Backend searches for groups using case-insensitive substring matching
- **Message limit**: Fetches last N messages per group per check (configurable)
- **WebSocket fallback**: Frontend automatically falls back to polling if WebSocket unavailable
- **Production mode**: When NODE_ENV=production or RAILWAY_ENVIRONMENT is set, backend serves frontend static files from frontend/dist and enables SPA routing
