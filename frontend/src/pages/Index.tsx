import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GroupList } from "@/components/GroupList";
import { ChannelList } from "@/components/ChannelList";
import { ChatView } from "@/components/ChatView";
import { AnalyticsPanel } from "@/components/AnalyticsPanel";
import { ReactionsDialog } from "@/components/ReactionsDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Languages, LogOut, Power, ShieldCheck, Eye, Users, Radio } from "lucide-react";
import { api, wsClient, Message, Event, Channel, ChannelMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import AdminUserSelector from "@/components/AdminUserSelector";
import { Badge } from "@/components/ui/badge";

// Dynamic URL configuration for local development and production
const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:3000' : '';

const Index = () => {
  const [viewMode, setViewMode] = useState<'groups' | 'channels'>('groups');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [translateMode, setTranslateMode] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channelMessages, setChannelMessages] = useState<ChannelMessage[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [logoutType, setLogoutType] = useState<'account' | 'whatsapp'>('account');
  const [viewingUserId, setViewingUserId] = useState<number | null>(null);
  const [viewingUserInfo, setViewingUserInfo] = useState<{username: string, email: string} | null>(null);
  const [showReactionsDialog, setShowReactionsDialog] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const { toast} = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { isAdmin, user: currentUser, isLoading: authLoading } = useAuth();

  // Calculate these before any hooks
  const isViewingAsAdmin = isAdmin && viewingUserId !== null;
  const targetUserId = isViewingAsAdmin ? viewingUserId! : (currentUser?.id || 0);
  const shouldShowUserSelector = isAdmin && viewingUserId === null;

  // Handle user selection for admin
  const handleUserSelect = async (userId: number) => {
    setViewingUserId(userId);
    // Fetch user info
    try {
      const response = await api.getUsers();
      if (response.success) {
        const user = response.users.find((u: any) => u.id === userId);
        if (user) {
          setViewingUserInfo({ username: user.username, email: user.email });
        }
      }
    } catch (error) {
      console.error('Error fetching user info:', error);
    }
  };

  // Handle switch user for admin
  const handleSwitchUser = () => {
    setViewingUserId(null);
    setViewingUserInfo(null);
    setSelectedGroupId(null);
    setMessages([]);
    setEvents([]);
  };

  // Fetch groups
  const { data: groupsData, isLoading: groupsLoading } = useQuery({
    queryKey: isViewingAsAdmin ? ['admin-view-groups', targetUserId] : ['groups'],
    queryFn: isViewingAsAdmin ? () => api.viewUserGroups(targetUserId) : api.getGroups,
    refetchInterval: 30000, // Refetch every 30 seconds
    enabled: targetUserId > 0,
  });

  // Fetch recent messages from all groups (for group list preview)
  const { data: allMessagesData, refetch: refetchAllMessages } = useQuery({
    queryKey: isViewingAsAdmin ? ['admin-view-all-messages', targetUserId] : ['all-messages'],
    queryFn: isViewingAsAdmin ? () => api.viewUserMessages(targetUserId, 100, 0) : () => api.getMessages(100, 0),
    enabled: !!groupsData?.groups?.length,
  });

  // Fetch all messages for the selected group (with higher limit to get all messages)
  const { data: selectedGroupMessagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: isViewingAsAdmin ? ['admin-view-group-messages', targetUserId, selectedGroupId] : ['group-messages', selectedGroupId],
    queryFn: () => {
      if (selectedGroupId) {
        return isViewingAsAdmin
          ? api.viewUserMessagesByGroup(targetUserId, selectedGroupId, 1000, 0)
          : api.getMessagesByGroup(selectedGroupId, 1000, 0);
      }
      return Promise.resolve({ success: true, messages: [], total: 0 });
    },
    enabled: !!selectedGroupId,
  });

  // Fetch all events (filtered by selected date, or all if selectedDate is null)
  const { data: eventsData } = useQuery({
    queryKey: isViewingAsAdmin ? ['admin-view-events', targetUserId, selectedDate] : ['events', selectedDate],
    queryFn: isViewingAsAdmin
      ? () => api.viewUserEvents(targetUserId, 10000, 0, selectedDate || undefined)
      : () => api.getEvents(10000, 0, selectedDate || undefined),
    enabled: !!groupsData?.groups?.length,
  });

  // Fetch statistics
  const { data: statsData } = useQuery({
    queryKey: isViewingAsAdmin ? ['admin-view-stats', targetUserId] : ['stats'],
    queryFn: isViewingAsAdmin ? () => api.viewUserStats(targetUserId) : api.getStats,
    refetchInterval: 60000, // Refetch every minute
    enabled: !!groupsData?.groups?.length,
  });

  // Fetch channels
  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ['channels', targetUserId],
    queryFn: api.getChannels,
    refetchInterval: 60000, // Refetch every minute
    enabled: targetUserId > 0 && viewMode === 'channels',
  });

  // Fetch messages from selected channel
  const { data: selectedChannelMessagesData, isLoading: channelMessagesLoading } = useQuery({
    queryKey: ['channel-messages', selectedChannelId],
    queryFn: () => {
      if (selectedChannelId) {
        return api.getChannelMessages(selectedChannelId, 100);
      }
      return Promise.resolve({ success: true, messages: [], count: 0 });
    },
    enabled: !!selectedChannelId && viewMode === 'channels',
  });

  // Check WhatsApp connection status periodically (skip if admin - even if not viewing a user yet)
  useEffect(() => {
    // Wait until auth is loaded before checking
    if (authLoading) return;

    // Skip check for all admins (whether viewing a user or on user selector)
    if (isAdmin) return;

    const checkWhatsAppStatus = async () => {
      try {
        const token = localStorage.getItem('token');
        if (!token) return;

        const response = await fetch(`${API_BASE_URL}/api/whatsapp/status`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        const data = await response.json();

        // If WhatsApp is disconnected, redirect to QR page
        if (!data.authenticated || data.authStatus === 'disconnected' || data.authStatus === 'not_initialized') {
          toast({
            title: "WhatsApp Disconnected",
            description: "Please scan the QR code again to reconnect.",
            variant: "destructive",
          });
          navigate('/whatsapp-connect');
        }
      } catch (error) {
        console.error('Error checking WhatsApp status:', error);
      }
    };

    // Check immediately
    checkWhatsAppStatus();

    // Check every 15 seconds
    const interval = setInterval(checkWhatsAppStatus, 15000);

    return () => clearInterval(interval);
  }, [navigate, toast, isAdmin, authLoading]);

  // Set initial selected group
  useEffect(() => {
    if (groupsData?.groups && groupsData.groups.length > 0 && !selectedGroupId) {
      setSelectedGroupId(groupsData.groups[0].id);
    }
  }, [groupsData, selectedGroupId]);

  // Set messages when data changes
  useEffect(() => {
    // Use group-specific messages if available, otherwise use all messages
    if (selectedGroupMessagesData?.messages) {
      setMessages(selectedGroupMessagesData.messages);
    } else if (allMessagesData?.messages) {
      setMessages(allMessagesData.messages);
    }
  }, [selectedGroupMessagesData, allMessagesData]);

  // Set events when data changes
  useEffect(() => {
    if (eventsData?.events) {
      setEvents(eventsData.events);
    }
  }, [eventsData]);

  // WebSocket connection for real-time updates (skip for admins)
  useEffect(() => {
    if (isAdmin) return; // Skip WebSocket for all admins

    wsClient.connect();

    const handleMessage = (data: any) => {
      console.log('📨 New message received:', data.message);

      // Add new message to the list (check for duplicates)
      setMessages((prev) => {
        const exists = prev.some(msg => msg.id === data.message.id);
        if (exists) return prev;
        return [data.message, ...prev];
      });

      // Show toast notification
      toast({
        title: `New message in ${data.message.groupName}`,
        description: `${data.message.sender}: ${data.message.message.substring(0, 50)}...`,
      });
    };

    const handleEvent = (data: any) => {
      console.log('👥 Event received:', data.event);

      setEvents((prev) => {
        const newEvent = data.event;
        const eventDate = newEvent.timestamp.substring(0, 10);

        // Remove any existing event of the same type for the same member on the same date
        const filtered = prev.filter(e => {
          if (e.memberId === newEvent.memberId && e.type === newEvent.type) {
            const eDate = e.timestamp.substring(0, 10);
            return eDate !== eventDate;
          }
          return true;
        });

        return [newEvent, ...filtered];
      });

      // Show toast notification
      const action = data.event.type === 'JOIN' ? 'joined' : data.event.type === 'LEAVE' ? 'left' : 'recorded certificate';
      toast({
        title: `${data.event.memberName} ${action}`,
        description: `Group: ${data.event.groupName}`,
      });
    };

    const handleGroupAdded = (data: any) => {
      console.log('➕ Group added:', data.group);

      // Invalidate and refetch groups
      queryClient.invalidateQueries({ queryKey: ['groups'] });

      toast({
        title: "New group added",
        description: `Now monitoring "${data.group.name}"`,
      });
    };

    const handleDisconnected = (data: any) => {
      console.log('⚠️ WhatsApp disconnected:', data);

      toast({
        title: "WhatsApp Disconnected",
        description: "Redirecting to reconnect...",
        variant: "destructive",
      });

      // Redirect to QR page after a short delay
      setTimeout(() => {
        navigate('/whatsapp-connect');
      }, 2000);
    };

    wsClient.on('message', handleMessage);
    wsClient.on('event', handleEvent);
    wsClient.on('group_added', handleGroupAdded);
    wsClient.on('disconnected', handleDisconnected);

    return () => {
      wsClient.off('message', handleMessage);
      wsClient.off('event', handleEvent);
      wsClient.off('group_added', handleGroupAdded);
      wsClient.off('disconnected', handleDisconnected);
    };
  }, [toast, refetchMessages, refetchAllMessages, queryClient, navigate]);

  // Handle component cleanup
  useEffect(() => {
    return () => {
      wsClient.disconnect();
    };
  }, []);

  const handleTranslate = () => {
    setTranslateMode(!translateMode);
  };

  const handleViewModeChange = (mode: 'groups' | 'channels') => {
    setViewMode(mode);
    // Clear selections when switching modes
    setSelectedGroupId(null);
    setSelectedChannelId(null);
    setMessages([]);
    setChannelMessages([]);
  };

  const handleChannelSelect = (channelId: string) => {
    setSelectedChannelId(channelId);
    setSelectedGroupId(null); // Clear group selection
  };

  const handleMessageReactionClick = (messageId: string) => {
    setSelectedMessageId(messageId);
    setShowReactionsDialog(true);
  };

  // Update channel messages when data changes
  useEffect(() => {
    if (selectedChannelMessagesData?.success && selectedChannelMessagesData?.messages) {
      setChannelMessages(selectedChannelMessagesData.messages);
    }
  }, [selectedChannelMessagesData]);

  const handleAddGroup = async (name: string) => {
    if (isViewingAsAdmin) {
      toast({
        title: "Read-only Mode",
        description: "You cannot add groups while viewing as admin",
        variant: "destructive",
      });
      return;
    }

    try {
      const result = await api.addGroup(name);

      toast({
        title: "Group added successfully",
        description: `Now monitoring "${result.group.name}"`,
      });

      // Refetch groups and messages to update the list
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      refetchAllMessages();
      refetchMessages();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to add group';
      toast({
        title: "Failed to add group",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (isViewingAsAdmin) {
      toast({
        title: "Read-only Mode",
        description: "You cannot delete groups while viewing as admin",
        variant: "destructive",
      });
      return;
    }

    try {
      await api.deleteGroup(groupId);

      toast({
        title: "Group removed",
        description: "Stopped monitoring this group",
      });

      // If we deleted the currently selected group, clear the selection
      if (selectedGroupId === groupId) {
        setSelectedGroupId(null);
      }

      // Refetch groups to update the list
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to remove group';
      toast({
        title: "Failed to remove group",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleAccountLogout = async () => {
    try {
      // Only clear JWT token - WhatsApp stays connected
      localStorage.removeItem('token');

      // Navigate to login
      navigate('/login');

      toast({
        title: "Logged out from account",
        description: "You can login again without scanning QR code",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to logout';
      toast({
        title: "Logout error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleWhatsAppLogout = async () => {
    try {
      // Call backend to disconnect WhatsApp and clear WhatsApp data
      await api.logoutWhatsApp();

      // Navigate to WhatsApp connect page
      navigate('/whatsapp-connect');

      toast({
        title: "WhatsApp disconnected",
        description: "You will need to scan QR code again. Your account remains logged in.",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to disconnect WhatsApp';
      toast({
        title: "Disconnect error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  // Transform backend data to frontend format
  const transformedGroups = groupsData?.groups?.map((group) => {
    // Ensure group has required fields and sanitize data
    const groupId = String(group.id || group.name || '');
    const groupName = String(group.name || '');

    // Use allMessagesData for group list previews
    const allMessages = allMessagesData?.messages || [];
    const groupMessages = allMessages.filter((msg) => msg.groupId === groupId);
    const lastMessage = groupMessages.length > 0 ? groupMessages[0] : null;

    const unreadCount = groupMessages.filter((msg) => {
      const msgTime = new Date(msg.timestamp);
      const now = new Date();
      const diffMinutes = (now.getTime() - msgTime.getTime()) / 1000 / 60;
      return diffMinutes < 5; // Consider messages from last 5 minutes as "unread"
    }).length;

    return {
      id: groupId,
      name: groupName,
      lastMessage: lastMessage?.message ? String(lastMessage.message) : "No messages yet",
      timestamp: lastMessage ? new Date(lastMessage.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }) : "",
      unread: unreadCount,
      members: group.memberCount || 0,
    };
  }) || [];

  // Messages are already filtered by the query, so just use them directly
  const selectedGroupMessages = messages;

  // Sort messages oldest first (ascending by timestamp)
  const sortedMessages = viewMode === 'groups'
    ? [...selectedGroupMessages].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )
    : [...channelMessages].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

  // Transform messages to frontend format
  const transformedMessages = viewMode === 'groups'
    ? sortedMessages.map((msg) => ({
        id: String(msg.id || ''),
        sender: String(msg.sender || 'Unknown'),
        content: String(msg.message || ''),
        timestamp: new Date(msg.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        isOwn: false, // We don't track which messages are from the current user
      }))
    : sortedMessages.map((msg) => ({
        id: String(msg.id || ''),
        sender: String((msg as any).channelName || 'Channel'),
        content: String(msg.content || ''),
        timestamp: new Date(msg.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        isOwn: false,
      }));

  // Get selected group or channel name
  const selectedGroupName = viewMode === 'groups'
    ? (selectedGroupId
        ? transformedGroups.find((g) => g.id === selectedGroupId)?.name || ""
        : "All Groups")
    : (selectedChannelId
        ? channelsData?.channels?.find((c: Channel) => c.id === selectedChannelId)?.name || ""
        : "Select a Channel");

  // Calculate analytics
  const selectedGroupStats = statsData?.stats?.groups?.find(
    (g) => g.id === selectedGroupId
  );

  // Filter events by selected group
  const filteredEvents = events.filter((e) => !selectedGroupId || e.groupId === selectedGroupId);

  // Calculate active users for selected group (distinct senders)
  const activeUsersInGroup = selectedGroupId
    ? new Set(selectedGroupMessages.map(msg => msg.sender)).size
    : statsData?.stats?.activeUsers || 0;

  const analytics = {
    totalMembers: selectedGroupStats?.memberCount || 0,
    joined: filteredEvents.filter((e) => e.type === 'JOIN').length,
    left: filteredEvents.filter((e) => e.type === 'LEAVE').length,
    messageCount: selectedGroupStats?.messageCount || selectedGroupMessages.length,
    activeUsers: activeUsersInGroup,
    certificates: filteredEvents.filter((e) => e.type === 'CERTIFICATE').length,
  };

  // Show user selector if admin and no user selected (must be after all hooks)
  if (shouldShowUserSelector) {
    return <AdminUserSelector onUserSelect={handleUserSelect} />;
  }

  // Show loading while auth is being checked
  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-xl font-semibold mb-2">Loading...</div>
          <div className="text-sm text-muted-foreground">Authenticating...</div>
        </div>
      </div>
    );
  }

  if (groupsLoading || messagesLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-xl font-semibold mb-2">Loading...</div>
          <div className="text-sm text-muted-foreground">Connecting to WhatsApp Analytics</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-foreground">
            {translateMode ? "WhatsApp 分析" : "WhatsApp Analytics"}
          </h1>

          {/* View Mode Toggle */}
          <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
            <Button
              variant={viewMode === 'groups' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleViewModeChange('groups')}
              className="gap-2"
            >
              <Users className="h-4 w-4" />
              {translateMode ? "群组" : "Groups"}
            </Button>
            <Button
              variant={viewMode === 'channels' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => handleViewModeChange('channels')}
              className="gap-2"
            >
              <Radio className="h-4 w-4" />
              {translateMode ? "频道" : "Channels"}
            </Button>
          </div>

          {isViewingAsAdmin && viewingUserInfo && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <Eye className="h-3 w-3" />
                Viewing {viewingUserInfo.username}
              </Badge>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isViewingAsAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSwitchUser}
              className="gap-2"
            >
              <Users className="h-4 w-4" />
              {translateMode ? "切换用户" : "Switch User"}
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="default"
              size="sm"
              onClick={() => navigate('/dashboard')}
              className="gap-2"
            >
              <ShieldCheck className="h-4 w-4" />
              {translateMode ? "管理面板" : "Admin Dashboard"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleTranslate}
            className="gap-2"
          >
            <Languages className="h-4 w-4" />
            {translateMode ? "显示原文" : "Translate to Chinese"}
          </Button>
          <ThemeToggle />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLogoutType('account');
              setShowLogoutDialog(true);
            }}
            className="gap-2"
          >
            <LogOut className="h-4 w-4" />
            {translateMode ? "退出账户" : "Logout from Account"}
          </Button>
          {!isViewingAsAdmin && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setLogoutType('whatsapp');
                setShowLogoutDialog(true);
              }}
              className="gap-2"
            >
              <Power className="h-4 w-4" />
              {translateMode ? "断开WhatsApp" : "Disconnect WhatsApp"}
            </Button>
          )}
        </div>
      </header>
      <div className="flex-1 grid grid-cols-12 overflow-hidden">
        <div className="col-span-3 h-full">
          {viewMode === 'groups' ? (
            <GroupList
              groups={transformedGroups}
              selectedGroupId={selectedGroupId || ""}
              onSelectGroup={setSelectedGroupId}
              onAddGroup={handleAddGroup}
              onDeleteGroup={handleDeleteGroup}
              translateMode={translateMode}
            />
          ) : (
            <ChannelList
              channels={channelsData?.channels || []}
              selectedChannelId={selectedChannelId || ""}
              onSelectChannel={handleChannelSelect}
              translateMode={translateMode}
            />
          )}
        </div>
        <div className="col-span-6 h-full">
          <ChatView
            messages={transformedMessages}
            groupName={selectedGroupName}
            groupId={selectedGroupId || ""}
            onMessageSent={() => {
              refetchMessages();
              refetchAllMessages();
            }}
            onReactionClick={handleMessageReactionClick}
          />
        </div>
        <div className="col-span-3 h-full">
          <AnalyticsPanel
            analytics={analytics}
            translateMode={translateMode}
            onDateFilterChange={setSelectedDate}
            events={filteredEvents}
            groupName={selectedGroupName}
            groupId={selectedGroupId}
            isViewingAsAdmin={isViewingAsAdmin}
            viewingUserId={viewingUserId}
          />
        </div>
      </div>

      {/* Logout Confirmation Dialog */}
      <Dialog open={showLogoutDialog} onOpenChange={setShowLogoutDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {logoutType === 'account'
                ? (translateMode ? "确认退出账户" : "Confirm Account Logout")
                : (translateMode ? "确认断开WhatsApp" : "Confirm WhatsApp Disconnect")
              }
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <p className="font-semibold">
                {logoutType === 'account'
                  ? (translateMode
                      ? "您确定要退出账户吗？"
                      : "Are you sure you want to logout from your account?")
                  : (translateMode
                      ? "您确定要断开WhatsApp吗？"
                      : "Are you sure you want to disconnect WhatsApp?")
                }
              </p>
              <p className="text-muted-foreground">
                {logoutType === 'account'
                  ? (translateMode
                      ? "如果您退出账户，您需要重新登录。您的WhatsApp连接将保持连接，无需重新扫描二维码。"
                      : "If you logout from your account, you will need to login again with your email and password. Your WhatsApp connection will remain active - no need to scan QR code again.")
                  : (translateMode
                      ? "如果您断开WhatsApp，您需要重新扫描二维码才能重新连接。您的账户将保持登录状态。"
                      : "If you disconnect WhatsApp, all WhatsApp data will be cleared and you will need to scan the QR code again. Your account will remain logged in.")
                }
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowLogoutDialog(false)}
            >
              {translateMode ? "取消" : "Cancel"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowLogoutDialog(false);
                if (logoutType === 'account') {
                  handleAccountLogout();
                } else {
                  handleWhatsAppLogout();
                }
              }}
            >
              {logoutType === 'account'
                ? (translateMode ? "是的，退出账户" : "Yes, Logout from Account")
                : (translateMode ? "是的，断开WhatsApp" : "Yes, Disconnect WhatsApp")
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reactions Dialog */}
      <ReactionsDialog
        open={showReactionsDialog}
        onOpenChange={setShowReactionsDialog}
        messageId={selectedMessageId}
      />
    </div>
  );
};

export default Index;
