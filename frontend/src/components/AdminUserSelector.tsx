import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Users, UserCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface User {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  whatsappAuthenticated: boolean;
  createdAt: string;
}

interface AdminUserSelectorProps {
  onUserSelect: (userId: number) => void;
}

export default function AdminUserSelector({ onUserSelect }: AdminUserSelectorProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const { user: currentUser } = useAuth();

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await api.getUsers();
      if (response.success) {
        setUsers(response.users);
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: response.error || "Failed to fetch users",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch users",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const whatsappConnectedUsers = users.filter(u => u.whatsappAuthenticated);

  const getInitials = (username: string) => {
    return username
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  const getRandomColor = (id: number) => {
    const colors = [
      'bg-blue-500',
      'bg-green-500',
      'bg-purple-500',
      'bg-pink-500',
      'bg-indigo-500',
      'bg-yellow-500',
      'bg-red-500',
      'bg-teal-500',
      'bg-orange-500',
      'bg-cyan-500',
    ];
    return colors[id % colors.length];
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center p-6">
      <Card className="max-w-5xl w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">Select User to View</CardTitle>
          <CardDescription className="text-base">
            Choose a WhatsApp-connected user to view their messages and analytics
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : whatsappConnectedUsers.length === 0 ? (
            <div className="text-center py-12">
              <Users className="h-16 w-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" />
              <p className="text-gray-500 dark:text-gray-400 text-lg font-medium mb-2">
                No WhatsApp Connected Users
              </p>
              <p className="text-gray-400 dark:text-gray-500 text-sm">
                Users need to connect their WhatsApp accounts first
              </p>
            </div>
          ) : (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4 mb-8">
                <div className="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <Users className="h-6 w-6 mx-auto mb-2 text-gray-500" />
                  <div className="text-2xl font-bold">{users.length}</div>
                  <div className="text-sm text-gray-500">Total Users</div>
                </div>
                <div className="text-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                  <UserCheck className="h-6 w-6 mx-auto mb-2 text-green-600" />
                  <div className="text-2xl font-bold text-green-600">{whatsappConnectedUsers.length}</div>
                  <div className="text-sm text-gray-500">WhatsApp Connected</div>
                </div>
                <div className="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <div className="text-2xl font-bold">{users.filter(u => u.isAdmin).length}</div>
                  <div className="text-sm text-gray-500">Admins</div>
                </div>
              </div>

              {/* User Circles */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 py-6">
                {whatsappConnectedUsers.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => onUserSelect(user.id)}
                    className="flex flex-col items-center gap-3 p-4 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 group"
                  >
                    {/* Circle Avatar */}
                    <div
                      className={`w-24 h-24 rounded-full ${getRandomColor(user.id)} flex items-center justify-center text-white text-2xl font-bold shadow-lg group-hover:shadow-xl group-hover:scale-110 transition-all duration-200`}
                    >
                      {getInitials(user.username)}
                    </div>

                    {/* User Info */}
                    <div className="text-center">
                      <p className="font-semibold text-gray-900 dark:text-white text-sm">
                        {user.username}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[120px]">
                        {user.email}
                      </p>
                      {user.id === currentUser?.id && (
                        <span className="inline-block mt-1 px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs rounded">
                          You
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
