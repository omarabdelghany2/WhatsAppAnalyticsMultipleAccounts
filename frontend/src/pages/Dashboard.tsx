import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Shield, ShieldOff, UserCog, ArrowLeft, RefreshCw, Trash2, Eye } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface User {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  whatsappAuthenticated: boolean;
  createdAt: string;
}

export default function Dashboard() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [actionType, setActionType] = useState<'grant' | 'revoke'>('grant');
  const { toast } = useToast();
  const { user: currentUser, logout } = useAuth();

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

  const handleAdminToggle = (user: User) => {
    setSelectedUser(user);
    setActionType(user.isAdmin ? 'revoke' : 'grant');
    setDialogOpen(true);
  };

  const confirmAdminToggle = async () => {
    if (!selectedUser) return;

    try {
      setUpdating(selectedUser.id);
      const newAdminStatus = !selectedUser.isAdmin;
      const response = await api.updateUserAdmin(selectedUser.id, newAdminStatus);

      if (response.success) {
        toast({
          title: "Success",
          description: response.message,
        });

        // Update the user in the list
        setUsers(users.map(u =>
          u.id === selectedUser.id ? { ...u, isAdmin: newAdminStatus } : u
        ));

        // If user removed their own admin status, redirect after 2 seconds
        if (selectedUser.id === currentUser?.id && !newAdminStatus) {
          toast({
            title: "Access Changed",
            description: "You removed your own admin privileges. Redirecting...",
            variant: "destructive",
          });
          setTimeout(() => {
            logout();
            window.location.href = '/login';
          }, 2000);
        }
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: response.error || "Failed to update user",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update user",
      });
    } finally {
      setUpdating(null);
      setDialogOpen(false);
      setSelectedUser(null);
    }
  };

  const handleDeleteUser = (user: User) => {
    if (user.id === currentUser?.id) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "You cannot delete your own account",
      });
      return;
    }
    setUserToDelete(user);
    setDeleteDialogOpen(true);
  };

  const confirmDeleteUser = async () => {
    if (!userToDelete) return;

    try {
      setDeleting(userToDelete.id);
      const response = await api.deleteUser(userToDelete.id);

      if (response.success) {
        toast({
          title: "Success",
          description: response.message,
        });

        // Remove user from the list
        setUsers(users.filter(u => u.id !== userToDelete.id));
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: response.error || "Failed to delete user",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete user",
      });
    } finally {
      setDeleting(null);
      setDeleteDialogOpen(false);
      setUserToDelete(null);
    }
  };

  const handleMakeMeAdmin = async () => {
    try {
      const response = await api.makeMeAdmin();
      if (response.success) {
        toast({
          title: "Success",
          description: response.message,
        });
        setTimeout(() => {
          logout();
          window.location.href = '/login';
        }, 2000);
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: response.error || "Failed to grant admin privileges",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to grant admin privileges",
      });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.href = '/'}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Home
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                Admin Dashboard
              </h1>
              <p className="text-gray-500 dark:text-gray-400">
                Manage users and admin privileges
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchUsers}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleMakeMeAdmin}
            >
              <UserCog className="h-4 w-4 mr-2" />
              Make Me Admin
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">Total Users</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{users.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">Admin Users</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{users.filter(u => u.isAdmin).length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-gray-500">WhatsApp Connected</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{users.filter(u => u.whatsappAuthenticated).length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Users Table */}
        <Card>
          <CardHeader>
            <CardTitle>User Management</CardTitle>
            <CardDescription>
              View and manage user accounts and admin privileges
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              </div>
            ) : users.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                No users found
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Username</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>WhatsApp</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Admin Access</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">
                          {user.username}
                          {user.id === currentUser?.id && (
                            <Badge variant="outline" className="ml-2">You</Badge>
                          )}
                        </TableCell>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          {user.isAdmin ? (
                            <Badge variant="default" className="gap-1">
                              <Shield className="h-3 w-3" />
                              Admin
                            </Badge>
                          ) : (
                            <Badge variant="secondary">User</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.whatsappAuthenticated ? (
                            <Badge variant="default" className="bg-green-500">Connected</Badge>
                          ) : (
                            <Badge variant="secondary">Not Connected</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          {formatDate(user.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Switch
                              checked={user.isAdmin}
                              onCheckedChange={() => handleAdminToggle(user)}
                              disabled={updating === user.id}
                            />
                            {updating === user.id && (
                              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.location.href = `/dashboard/view/${user.id}`}
                              title="View user data"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDeleteUser(user)}
                              disabled={deleting === user.id || user.id === currentUser?.id}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              title={user.id === currentUser?.id ? "Cannot delete your own account" : "Delete user"}
                            >
                              {deleting === user.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Admin Toggle Confirmation Dialog */}
        <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {actionType === 'grant' ? 'Grant Admin Access' : 'Revoke Admin Access'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {actionType === 'grant' ? (
                  <>
                    Are you sure you want to grant admin privileges to{' '}
                    <span className="font-semibold">{selectedUser?.username}</span>?
                    They will be able to manage users and access the admin dashboard.
                  </>
                ) : (
                  <>
                    Are you sure you want to revoke admin privileges from{' '}
                    <span className="font-semibold">{selectedUser?.username}</span>?
                    {selectedUser?.id === currentUser?.id && (
                      <span className="block mt-2 text-red-600 dark:text-red-400 font-semibold">
                        Warning: You are removing your own admin access. You will be logged out.
                      </span>
                    )}
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmAdminToggle}>
                {actionType === 'grant' ? (
                  <>
                    <Shield className="h-4 w-4 mr-2" />
                    Grant Access
                  </>
                ) : (
                  <>
                    <ShieldOff className="h-4 w-4 mr-2" />
                    Revoke Access
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete User Confirmation Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete User Account</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete the account for{' '}
                <span className="font-semibold">{userToDelete?.username}</span> ({userToDelete?.email})?
                <span className="block mt-2 text-red-600 dark:text-red-400 font-semibold">
                  Warning: This action cannot be undone. All user data, messages, events, and WhatsApp sessions will be permanently deleted.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDeleteUser}
                className="bg-red-600 hover:bg-red-700"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete User
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
