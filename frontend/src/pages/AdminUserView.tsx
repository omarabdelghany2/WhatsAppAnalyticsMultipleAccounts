import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GroupList } from "@/components/GroupList";
import { ChatView } from "@/components/ChatView";
import { AnalyticsPanel } from "@/components/AnalyticsPanel";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Eye } from "lucide-react";
import { api, Message, Event } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

const AdminUserView = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [viewingUser, setViewingUser] = useState<{username: string, email: string} | null>(null);

  const viewUserIdNum = userId ? parseInt(userId) : 0;

  // Fetch user info
  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const response = await api.getUsers();
        if (response.success) {
          const user = response.users.find((u: any) => u.id === viewUserIdNum);
          if (user) {
            setViewingUser({ username: user.username, email: user.email });
          }
        }
      } catch (error) {
        console.error('Error fetching user info:', error);
      }
    };
    fetchUserInfo();
  }, [viewUserIdNum]);

  // Fetch groups for this user
  const { data: groupsData, isLoading: groupsLoading } = useQuery({
    queryKey: ['admin-view-groups', viewUserIdNum],
    queryFn: () => api.viewUserGroups(viewUserIdNum),
    enabled: viewUserIdNum > 0,
  });

  // Fetch all messages for this user
  const { data: allMessagesData } = useQuery({
    queryKey: ['admin-view-all-messages', viewUserIdNum],
    queryFn: () => api.viewUserMessages(viewUserIdNum, 100, 0),
    enabled: viewUserIdNum > 0 && !!groupsData?.groups?.length,
  });

  // Fetch messages for selected group
  const { data: selectedGroupMessagesData, isLoading: messagesLoading } = useQuery({
    queryKey: ['admin-view-group-messages', viewUserIdNum, selectedGroupId],
    queryFn: () => {
      if (selectedGroupId) {
        return api.viewUserMessagesByGroup(viewUserIdNum, selectedGroupId, 1000, 0);
      }
      return Promise.resolve({ success: true, messages: [], total: 0 });
    },
    enabled: viewUserIdNum > 0 && !!selectedGroupId,
  });

  // Fetch events for this user
  const { data: eventsData } = useQuery({
    queryKey: ['admin-view-events', viewUserIdNum, selectedDate],
    queryFn: () => api.viewUserEvents(viewUserIdNum, 10000, 0, selectedDate || undefined),
    enabled: viewUserIdNum > 0 && !!groupsData?.groups?.length,
  });

  // Fetch statistics for this user
  const { data: statsData } = useQuery({
    queryKey: ['admin-view-stats', viewUserIdNum],
    queryFn: () => api.viewUserStats(viewUserIdNum),
    enabled: viewUserIdNum > 0 && !!groupsData?.groups?.length,
  });

  // Update messages and events when data changes
  useEffect(() => {
    if (selectedGroupMessagesData?.messages) {
      setMessages(selectedGroupMessagesData.messages);
    }
  }, [selectedGroupMessagesData]);

  useEffect(() => {
    if (eventsData?.events) {
      setEvents(eventsData.events);
    }
  }, [eventsData]);

  // Transform groups data
  const transformedGroups = groupsData?.groups?.map((group: any) => {
    const groupMessages = allMessagesData?.messages?.filter(
      (msg: Message) => msg.groupId === group.id
    ) || [];

    const lastMessage = groupMessages.length > 0 ? groupMessages[0] : null;

    return {
      id: group.id,
      name: group.name,
      lastMessage: lastMessage ? lastMessage.message : null,
      lastMessageTime: lastMessage ? lastMessage.timestamp : null,
      unreadCount: 0,
    };
  }) || [];

  // Calculate analytics for the selected group
  const selectedGroupStats = statsData?.stats?.groups?.find(
    (g: any) => g.id === selectedGroupId
  );

  const selectedGroupMessages = messages.filter((m) => !selectedGroupId || m.groupId === selectedGroupId);
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

  const selectedGroupName = selectedGroupId
    ? transformedGroups.find((g) => g.id === selectedGroupId)?.name || ""
    : "All Groups";

  if (groupsLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading user data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/dashboard')}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="gap-1">
              <Eye className="h-3 w-3" />
              Admin View
            </Badge>
            {viewingUser && (
              <div>
                <h1 className="text-xl font-bold text-foreground">
                  {viewingUser.username}'s WhatsApp Analytics
                </h1>
                <p className="text-sm text-muted-foreground">{viewingUser.email}</p>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
        </div>
      </header>
      <div className="flex-1 grid grid-cols-12 overflow-hidden">
        <div className="col-span-3 h-full">
          <GroupList
            groups={transformedGroups}
            selectedGroupId={selectedGroupId || ""}
            onSelectGroup={setSelectedGroupId}
            onAddGroup={() => {
              toast({
                title: "Read-only Mode",
                description: "You cannot add groups while viewing as admin",
                variant: "destructive",
              });
            }}
            onDeleteGroup={() => {
              toast({
                title: "Read-only Mode",
                description: "You cannot delete groups while viewing as admin",
                variant: "destructive",
              });
            }}
            translateMode={false}
          />
        </div>
        <div className="col-span-6 h-full">
          <ChatView
            messages={selectedGroupMessages}
            groupName={selectedGroupName}
          />
        </div>
        <div className="col-span-3 h-full">
          <AnalyticsPanel
            analytics={analytics}
            translateMode={false}
            onDateFilterChange={setSelectedDate}
            events={filteredEvents}
            groupName={selectedGroupName}
            groupId={selectedGroupId}
            isViewingAsAdmin={true}
            viewingUserId={viewUserIdNum}
          />
        </div>
      </div>
    </div>
  );
};

export default AdminUserView;
