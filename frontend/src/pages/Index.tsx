import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GroupList } from "@/components/GroupList";
import { ChatView } from "@/components/ChatView";
import { AnalyticsPanel } from "@/components/AnalyticsPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Languages, LogOut } from "lucide-react";
import { api, wsClient, Message, Event } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";

const Index = () => {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [translateMode, setTranslateMode] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => {
    // Default to today's date in YYYY-MM-DD format for "Specific Day" mode
    const today = new Date();
    return today.toISOString().split('T')[0];
  });
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Fetch groups
  const { data: groupsData, isLoading: groupsLoading } = useQuery({
    queryKey: ['groups'],
    queryFn: api.getGroups,
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  // Fetch all messages
  const { data: messagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: ['messages'],
    queryFn: () => api.getMessages(100, 0),
    enabled: !!groupsData?.groups?.length,
  });

  // Fetch all events (filtered by selected date, or all if selectedDate is null)
  const { data: eventsData } = useQuery({
    queryKey: ['events', selectedDate],
    queryFn: () => api.getEvents(100, 0, selectedDate || undefined),
    enabled: !!groupsData?.groups?.length,
  });

  // Fetch statistics
  const { data: statsData } = useQuery({
    queryKey: ['stats'],
    queryFn: api.getStats,
    refetchInterval: 60000, // Refetch every minute
    enabled: !!groupsData?.groups?.length,
  });

  // Set initial selected group
  useEffect(() => {
    if (groupsData?.groups && groupsData.groups.length > 0 && !selectedGroupId) {
      setSelectedGroupId(groupsData.groups[0].id);
    }
  }, [groupsData, selectedGroupId]);

  // Set messages when data changes
  useEffect(() => {
    if (messagesData?.messages) {
      setMessages(messagesData.messages);
    }
  }, [messagesData]);

  // Set events when data changes
  useEffect(() => {
    if (eventsData?.events) {
      setEvents(eventsData.events);
    }
  }, [eventsData]);

  // WebSocket connection for real-time updates
  useEffect(() => {
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

    wsClient.on('message', handleMessage);
    wsClient.on('event', handleEvent);
    wsClient.on('group_added', handleGroupAdded);

    return () => {
      wsClient.off('message', handleMessage);
      wsClient.off('event', handleEvent);
      wsClient.off('group_added', handleGroupAdded);
    };
  }, [toast, refetchMessages, queryClient]);

  // Handle component cleanup
  useEffect(() => {
    return () => {
      wsClient.disconnect();
    };
  }, [toast, refetchMessages, queryClient]);

  const handleTranslate = () => {
    setTranslateMode(!translateMode);
  };

  const handleAddGroup = async (name: string) => {
    try {
      const result = await api.addGroup(name);

      toast({
        title: "Group added successfully",
        description: `Now monitoring "${result.group.name}"`,
      });

      // Refetch groups and messages to update the list
      queryClient.invalidateQueries({ queryKey: ['groups'] });
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

  const handleLogout = async () => {
    try {
      // Call backend logout to clear all data and disconnect WhatsApp
      await api.logout();

      // Disconnect WebSocket
      wsClient.disconnect();

      // Clear local storage
      localStorage.removeItem('auth_token');

      // Navigate to login
      navigate('/login');

      toast({
        title: "Logged out successfully",
        description: "All data cleared and WhatsApp connection terminated",
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

  // Transform backend data to frontend format
  const transformedGroups = groupsData?.groups?.map((group) => {
    const groupMessages = messages.filter((msg) => msg.groupId === group.id);
    const lastMessage = groupMessages.length > 0 ? groupMessages[0] : null;

    const unreadCount = groupMessages.filter((msg) => {
      const msgTime = new Date(msg.timestamp);
      const now = new Date();
      const diffMinutes = (now.getTime() - msgTime.getTime()) / 1000 / 60;
      return diffMinutes < 5; // Consider messages from last 5 minutes as "unread"
    }).length;

    return {
      id: group.id,
      name: group.name,
      lastMessage: lastMessage?.message || "No messages yet",
      timestamp: lastMessage ? new Date(lastMessage.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }) : "",
      unread: unreadCount,
      members: group.memberCount,
    };
  }) || [];

  // Get messages for selected group
  const selectedGroupMessages = selectedGroupId
    ? messages.filter((msg) => msg.groupId === selectedGroupId)
    : messages;

  // Sort messages oldest first (ascending by timestamp)
  const sortedMessages = [...selectedGroupMessages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Transform messages to frontend format
  const transformedMessages = sortedMessages.map((msg) => ({
    id: msg.id,
    sender: msg.sender,
    content: msg.message,
    timestamp: new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    }),
    isOwn: false, // We don't track which messages are from the current user
  }));

  // Get selected group name
  const selectedGroupName = selectedGroupId
    ? transformedGroups.find((g) => g.id === selectedGroupId)?.name || ""
    : "All Groups";

  // Calculate analytics
  const selectedGroupStats = statsData?.stats?.groups?.find(
    (g) => g.id === selectedGroupId
  );

  // Filter events by selected group
  const filteredEvents = events.filter((e) => !selectedGroupId || e.groupId === selectedGroupId);

  const analytics = {
    totalMembers: selectedGroupStats?.memberCount || 0,
    joined: filteredEvents.filter((e) => e.type === 'JOIN').length,
    left: filteredEvents.filter((e) => e.type === 'LEAVE').length,
    messageCount: selectedGroupStats?.messageCount || selectedGroupMessages.length,
    activeUsers: selectedGroupStats?.topSenders?.length || 0,
    certificates: filteredEvents.filter((e) => e.type === 'CERTIFICATE').length,
  };

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
        <h1 className="text-xl font-bold text-foreground">
          {translateMode ? "WhatsApp 分析" : "WhatsApp Analytics"}
        </h1>
        <div className="flex items-center gap-2">
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
            variant="destructive"
            size="sm"
            onClick={() => setShowLogoutDialog(true)}
            className="gap-2"
          >
            <LogOut className="h-4 w-4" />
            {translateMode ? "登出" : "Logout"}
          </Button>
        </div>
      </header>
      <div className="flex-1 grid grid-cols-12 overflow-hidden">
        <div className="col-span-3">
          <GroupList
            groups={transformedGroups}
            selectedGroupId={selectedGroupId || ""}
            onSelectGroup={setSelectedGroupId}
            onAddGroup={handleAddGroup}
            onDeleteGroup={handleDeleteGroup}
            translateMode={translateMode}
          />
        </div>
        <div className="col-span-6">
          <ChatView
            messages={transformedMessages}
            groupName={selectedGroupName}
          />
        </div>
        <div className="col-span-3">
          <AnalyticsPanel
            analytics={analytics}
            translateMode={translateMode}
            onDateFilterChange={setSelectedDate}
            events={filteredEvents}
            groupName={selectedGroupName}
          />
        </div>
      </div>

      {/* Logout Confirmation Dialog */}
      <Dialog open={showLogoutDialog} onOpenChange={setShowLogoutDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              {translateMode ? "确认登出" : "Confirm Logout"}
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <p className="font-semibold">
                {translateMode
                  ? "您确定要登出吗？"
                  : "Are you sure you want to logout?"}
              </p>
              <p className="text-muted-foreground">
                {translateMode
                  ? "如果您登出，系统将停止监听所有群组消息，并且您将失去当前的聊天连接。"
                  : "If you logout, the system will stop listening to all group messages and you will lose the current chat connection."}
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
                handleLogout();
              }}
            >
              {translateMode ? "是的，登出" : "Yes, Logout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Index;
