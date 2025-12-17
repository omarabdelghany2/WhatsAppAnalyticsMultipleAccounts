// Dynamic URL configuration for local development and production
const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:3000' : '';  // localhost for dev, relative URLs for production
const WS_URL = import.meta.env.DEV ? 'ws://localhost:3000/ws' : 'wss://whatsappanalytics-productionn.up.railway.app/ws';

// Helper to get auth headers
function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export interface Message {
  id: string;
  groupId: string;
  groupName: string;
  sender: string;
  message: string;
  timestamp: string;
  replied_to_message_id?: string | null;
  replied_to_sender?: string | null;
  replied_to_message?: string | null;
}

export interface Event {
  id: string;
  groupId: string;
  groupName: string;
  type: 'JOIN' | 'LEAVE' | 'CERTIFICATE';
  memberId: string;
  memberName: string;
  timestamp: string;
  certificateName?: string;
}

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
    const response = await fetch(`${API_BASE_URL}/api/groups`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async getMessages(limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/messages?limit=${limit}&offset=${offset}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async getMessagesByGroup(groupId: string, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/messages/${groupId}?limit=${limit}&offset=${offset}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async getEvents(limit = 100, offset = 0, date?: string, memberId?: string) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString()
    });
    if (date) params.append('date', date);
    if (memberId) params.append('memberId', memberId);
    const response = await fetch(`${API_BASE_URL}/api/events?${params}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async getEventsByGroup(groupId: string, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/events/${groupId}?limit=${limit}&offset=${offset}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async searchMessages(query: string, groupId?: string, limit = 100) {
    const params = new URLSearchParams({ q: query, limit: limit.toString() });
    if (groupId) params.append('groupId', groupId);
    const response = await fetch(`${API_BASE_URL}/api/search?${params}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async sendMessage(groupId: string, message: string, file?: File, messageType?: 'text' | 'poll', pollOptions?: string[], allowMultipleAnswers?: boolean, replyToMessageId?: string, mentions?: string[]) {
    const formData = new FormData();
    formData.append('groupId', groupId);
    formData.append('message', message);

    if (file) {
      formData.append('file', file);
    }

    if (messageType) {
      formData.append('messageType', messageType);
    }

    if (pollOptions && pollOptions.length > 0) {
      formData.append('pollOptions', JSON.stringify(pollOptions));
    }

    if (allowMultipleAnswers !== undefined) {
      formData.append('allowMultipleAnswers', allowMultipleAnswers.toString());
    }

    if (replyToMessageId) {
      formData.append('replyToMessageId', replyToMessageId);
    }

    if (mentions && mentions.length > 0) {
      formData.append('mentions', JSON.stringify(mentions));
    }

    const token = localStorage.getItem('token');
    const headers: HeadersInit = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}/api/messages/send`, {
      method: 'POST',
      headers: headers,
      body: formData,
    });
    return response.json();
  },

  async getAllChats() {
    const response = await fetch(`${API_BASE_URL}/api/whatsapp/all-chats`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async broadcastMessage(groupIds: string[], message: string, file?: File, messageType?: 'text' | 'poll', pollOptions?: string[], gapTime?: number, allowMultipleAnswers?: boolean, mentions?: string[]) {
    const formData = new FormData();
    formData.append('groupIds', JSON.stringify(groupIds));
    formData.append('message', message);
    formData.append('gapTime', (gapTime || 10).toString());

    if (file) {
      formData.append('file', file);
    }

    if (messageType) {
      formData.append('messageType', messageType);
    }

    if (pollOptions && pollOptions.length > 0) {
      formData.append('pollOptions', JSON.stringify(pollOptions));
    }

    if (allowMultipleAnswers !== undefined) {
      formData.append('allowMultipleAnswers', allowMultipleAnswers.toString());
    }

    if (mentions && mentions.length > 0) {
      formData.append('mentions', JSON.stringify(mentions));
    }

    const token = localStorage.getItem('token');
    const headers: HeadersInit = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}/api/messages/broadcast`, {
      method: 'POST',
      headers: headers,
      body: formData,
    });
    return response.json();
  },

  async schedulebroadcast(groupIds: string[], message: string, scheduledTime: string, file?: File, messageType?: 'text' | 'poll', pollOptions?: string[], gapTime?: number, allowMultipleAnswers?: boolean, mentions?: string[]) {
    const formData = new FormData();
    formData.append('groupIds', JSON.stringify(groupIds));
    formData.append('message', message);
    formData.append('scheduledTime', scheduledTime);
    formData.append('gapTime', (gapTime || 10).toString());

    if (file) {
      formData.append('file', file);
    }

    if (messageType) {
      formData.append('messageType', messageType);
    }

    if (pollOptions && pollOptions.length > 0) {
      formData.append('pollOptions', JSON.stringify(pollOptions));
    }

    if (allowMultipleAnswers !== undefined) {
      formData.append('allowMultipleAnswers', allowMultipleAnswers.toString());
    }

    if (mentions && mentions.length > 0) {
      formData.append('mentions', JSON.stringify(mentions));
    }

    const token = localStorage.getItem('token');
    const headers: HeadersInit = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}/api/messages/broadcast/schedule`, {
      method: 'POST',
      headers: headers,
      body: formData,
    });
    return response.json();
  },

  async getScheduledBroadcasts(status?: 'pending' | 'sent' | 'failed' | 'all') {
    const url = status && status !== 'all'
      ? `${API_BASE_URL}/api/messages/broadcast/scheduled?status=${status}`
      : `${API_BASE_URL}/api/messages/broadcast/scheduled`;
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async cancelScheduledBroadcast(scheduleId: number) {
    const response = await fetch(`${API_BASE_URL}/api/messages/broadcast/scheduled/${scheduleId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async updateScheduledBroadcastTime(scheduleId: number, scheduledTime: string) {
    const response = await fetch(`${API_BASE_URL}/api/messages/broadcast/scheduled/${scheduleId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ scheduledTime }),
    });
    return response.json();
  },

  async getStats(date?: string) {
    const url = date ? `${API_BASE_URL}/api/stats?date=${encodeURIComponent(date)}` : `${API_BASE_URL}/api/stats`;
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async addGroup(name: string) {
    const response = await fetch(`${API_BASE_URL}/api/groups`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ name }),
    });
    return response.json();
  },

  async deleteGroup(groupId: string) {
    const response = await fetch(`${API_BASE_URL}/api/groups/${groupId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async getGroupMembers(groupId: string) {
    const response = await fetch(`${API_BASE_URL}/api/groups/${groupId}/members`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async logout() {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async logoutWhatsApp() {
    const response = await fetch(`${API_BASE_URL}/api/whatsapp/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  // Admin endpoints
  async getUsers() {
    const response = await fetch(`${API_BASE_URL}/api/admin/users`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async updateUserAdmin(userId: number, isAdmin: boolean) {
    const response = await fetch(`${API_BASE_URL}/api/admin/users/${userId}/admin`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ isAdmin }),
    });
    return response.json();
  },

  async deleteUser(userId: number) {
    const response = await fetch(`${API_BASE_URL}/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async makeMeAdmin() {
    const response = await fetch(`${API_BASE_URL}/api/admin/make-me-admin`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  // Admin view user data endpoints
  async viewUserGroups(userId: number) {
    const response = await fetch(`${API_BASE_URL}/api/admin/view-user/${userId}/groups`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserMessages(userId: number, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/admin/view-user/${userId}/messages?limit=${limit}&offset=${offset}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserMessagesByGroup(userId: number, groupId: string, limit = 100, offset = 0) {
    const response = await fetch(`${API_BASE_URL}/api/admin/view-user/${userId}/messages/${groupId}?limit=${limit}&offset=${offset}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserEvents(userId: number, limit = 100, offset = 0, date?: string, memberId?: string) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      offset: offset.toString()
    });
    if (date) params.append('date', date);
    if (memberId) params.append('memberId', memberId);
    const response = await fetch(`${API_BASE_URL}/api/admin/view-user/${userId}/events?${params}`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserStats(userId: number, date?: string) {
    const url = date
      ? `${API_BASE_URL}/api/admin/view-user/${userId}/stats?date=${encodeURIComponent(date)}`
      : `${API_BASE_URL}/api/admin/view-user/${userId}/stats`;
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserGroupMembers(userId: number, groupId: string) {
    const response = await fetch(`${API_BASE_URL}/api/admin/view-user/${userId}/groups/${groupId}/members`, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },

  async viewUserScheduledBroadcasts(userId: number, status?: 'pending' | 'sent' | 'failed' | 'all') {
    const url = status && status !== 'all'
      ? `${API_BASE_URL}/api/admin/view-user/${userId}/scheduled-broadcasts?status=${status}`
      : `${API_BASE_URL}/api/admin/view-user/${userId}/scheduled-broadcasts`;
    const response = await fetch(url, {
      headers: getAuthHeaders(),
    });
    return response.json();
  },
};

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('WebSocket: Max reconnection attempts reached. Running in polling mode.');
      return;
    }

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        console.log('✅ WebSocket connected');
        this.reconnectAttempts = 0; // Reset on successful connection
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
        console.warn('⚠️ WebSocket error (app will use polling):', error);
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.reconnectAttempts++;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        } else {
          console.log('🔄 WebSocket unavailable - using HTTP polling instead');
        }
      };
    } catch (error) {
      console.warn('WebSocket initialization failed, using polling mode:', error);
    }
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
