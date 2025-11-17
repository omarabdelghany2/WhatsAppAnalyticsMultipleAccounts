// Use relative URLs in production (Railway serves both frontend and backend)
// In development, use localhost
// Old hardcoded approach (replaced for Railway deployment):
// const API_BASE_URL = 'http://localhost:3000';
// const WS_URL = 'ws://localhost:3000';
const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3000');
const WS_URL = import.meta.env.VITE_WS_URL || (import.meta.env.MODE === 'production' ? `wss://${window.location.host}` : 'ws://localhost:3000');

export const api = {
  async getHealth() {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    return response.json();
  },

  async getAuthStatus() {
    const response = await fetch(`${API_BASE_URL}/api/auth/status`);
    return response.json();
  },

  async getQRCode() {
    const response = await fetch(`${API_BASE_URL}/api/auth/qr`);
    return response.json();
  },

  async getGroups() {
    const response = await fetch(`${API_BASE_URL}/api/groups`);
    return response.json();
  },

  async getMessages(limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/messages?limit=${limit}&offset=${offset}`);
    return response.json();
  },

  async getMessagesByGroup(groupId: string, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/messages/${groupId}?limit=${limit}&offset=${offset}`);
    return response.json();
  },

  async getEvents(limit = 100, offset = 0, date?: string, memberId?: string) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString()
    });
    if (date) params.append('date', date);
    if (memberId) params.append('memberId', memberId);
    const response = await fetch(`${API_BASE_URL}/api/events?${params}`);
    return response.json();
  },

  async getEventsByGroup(groupId: string, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/events/${groupId}?limit=${limit}&offset=${offset}`);
    return response.json();
  },

  async searchMessages(query: string, groupId?: string, limit = 100) {
    const params = new URLSearchParams({ q: query, limit: limit.toString() });
    if (groupId) params.append('groupId', groupId);
    const response = await fetch(`${API_BASE_URL}/api/search?${params}`);
    return response.json();
  },

  async getStats() {
    const response = await fetch(`${API_BASE_URL}/api/stats`);
    return response.json();
  },

  async addGroup(name: string) {
    const response = await fetch(`${API_BASE_URL}/api/groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    return response.json();
  },

  async deleteGroup(groupId: string) {
    const response = await fetch(`${API_BASE_URL}/api/groups/${groupId}`, {
      method: 'DELETE',
    });
    return response.json();
  },

  async logout() {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
    });
    return response.json();
  },
};

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const type = data.type;

        const listeners = this.listeners.get(type);
        if (listeners) {
          listeners.forEach(listener => listener(data));
        }

        const allListeners = this.listeners.get('*');
        if (allListeners) {
          allListeners.forEach(listener => listener(data));
        }
      } catch (error) {
        console.error('WebSocket message parse error:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      this.reconnectTimeout = setTimeout(() => this.connect(), 3000);
    };
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(event: string, callback: (data: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: (data: any) => void) {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }
}

export const wsClient = new WSClient();
