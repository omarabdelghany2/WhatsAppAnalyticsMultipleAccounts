import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Badge } from './ui/badge';
import { Calendar, Clock, Trash2, Edit, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { ScrollArea } from './ui/scroll-area';

interface ScheduledBroadcastsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adminViewUserId?: number;
}

interface ScheduledBroadcast {
  id: number;
  group_ids: string[];
  message: string;
  message_type: string;
  poll_options: string[] | null;
  allow_multiple_answers: boolean;
  gap_time: number;
  scheduled_time: string;
  status: 'pending' | 'sent' | 'failed' | 'executing';
  created_at: string;
  executed_at: string | null;
  result_summary: string | null;
  has_file: boolean;
  file_name: string | null;
}

export function ScheduledBroadcastsDialog({ open, onOpenChange, adminViewUserId }: ScheduledBroadcastsDialogProps) {
  const [broadcasts, setBroadcasts] = useState<ScheduledBroadcast[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'sent' | 'failed'>('all');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');

  useEffect(() => {
    if (open) {
      loadScheduledBroadcasts();
    }
  }, [open, filterStatus, adminViewUserId]);

  const loadScheduledBroadcasts = async () => {
    setIsLoading(true);
    try {
      let result;
      if (adminViewUserId) {
        // Admin viewing another user's scheduled broadcasts
        console.log('Admin viewing user scheduled broadcasts:', adminViewUserId, 'status:', filterStatus);
        result = await api.viewUserScheduledBroadcasts(adminViewUserId, filterStatus);
        console.log('Admin API result:', result);
      } else {
        // User viewing their own scheduled broadcasts
        console.log('User viewing own scheduled broadcasts, status:', filterStatus);
        result = await api.getScheduledBroadcasts(filterStatus);
        console.log('User API result:', result);
      }

      if (result.success) {
        console.log('Setting broadcasts:', result.broadcasts.length, 'broadcasts');
        setBroadcasts(result.broadcasts);
      } else {
        console.error('API returned error:', result.error);
        toast.error('Failed to load scheduled broadcasts: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Error loading scheduled broadcasts:', error);
      toast.error('Failed to load scheduled broadcasts');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async (id: number) => {
    if (!confirm('Are you sure you want to cancel this scheduled broadcast?')) {
      return;
    }

    try {
      const result = await api.cancelScheduledBroadcast(id);
      if (result.success) {
        toast.success('Scheduled broadcast cancelled successfully');
        loadScheduledBroadcasts();
      } else {
        toast.error(result.error || 'Failed to cancel broadcast');
      }
    } catch (error) {
      console.error('Error cancelling broadcast:', error);
      toast.error('Failed to cancel broadcast');
    }
  };

  const handleStartEdit = (broadcast: ScheduledBroadcast) => {
    setEditingId(broadcast.id);
    const scheduledDateTime = new Date(broadcast.scheduled_time);
    setEditDate(scheduledDateTime.toISOString().split('T')[0]);
    setEditTime(scheduledDateTime.toTimeString().slice(0, 5));
  };

  const handleSaveEdit = async (id: number) => {
    if (!editDate || !editTime) {
      toast.error('Please select both date and time');
      return;
    }

    const scheduledDateTime = new Date(`${editDate}T${editTime}`);
    const now = new Date();

    if (scheduledDateTime <= now) {
      toast.error('Scheduled time must be in the future');
      return;
    }

    try {
      const result = await api.updateScheduledBroadcastTime(id, scheduledDateTime.toISOString());
      if (result.success) {
        toast.success('Scheduled time updated successfully');
        setEditingId(null);
        setEditDate('');
        setEditTime('');
        loadScheduledBroadcasts();
      } else {
        toast.error(result.error || 'Failed to update scheduled time');
      }
    } catch (error) {
      console.error('Error updating scheduled time:', error);
      toast.error('Failed to update scheduled time');
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditDate('');
    setEditTime('');
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
      case 'executing':
        return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Executing</Badge>;
      case 'sent':
        return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200"><CheckCircle className="h-3 w-3 mr-1" />Sent</Badge>;
      case 'failed':
        return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Scheduled Broadcasts{adminViewUserId && ' (Admin View)'}</DialogTitle>
          <DialogDescription>
            {adminViewUserId
              ? 'View scheduled broadcasts for this user (read-only)'
              : 'View and manage your scheduled broadcasts'
            }
          </DialogDescription>
        </DialogHeader>

        {/* Filter */}
        <div className="flex gap-2">
          <Button
            variant={filterStatus === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('all')}
          >
            All
          </Button>
          <Button
            variant={filterStatus === 'pending' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('pending')}
          >
            Pending
          </Button>
          <Button
            variant={filterStatus === 'sent' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('sent')}
          >
            Sent
          </Button>
          <Button
            variant={filterStatus === 'failed' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterStatus('failed')}
          >
            Failed
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadScheduledBroadcasts}
            className="ml-auto"
          >
            Refresh
          </Button>
        </div>

        {/* Table */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : broadcasts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No scheduled broadcasts found
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Scheduled Time</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Groups</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {broadcasts.map((broadcast) => (
                  <TableRow key={broadcast.id}>
                    <TableCell>{getStatusBadge(broadcast.status)}</TableCell>
                    <TableCell>
                      {editingId === broadcast.id ? (
                        <div className="space-y-2">
                          <Input
                            type="date"
                            value={editDate}
                            onChange={(e) => setEditDate(e.target.value)}
                            min={new Date().toISOString().split('T')[0]}
                            className="w-40"
                          />
                          <Input
                            type="time"
                            value={editTime}
                            onChange={(e) => setEditTime(e.target.value)}
                            className="w-40"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-gray-400" />
                          <span className="text-sm">{formatDateTime(broadcast.scheduled_time)}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-xs truncate">
                        {broadcast.message || '(No message)'}
                        {broadcast.has_file && (
                          <Badge variant="outline" className="ml-2 text-xs">
                            {broadcast.file_name}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{broadcast.group_ids.length} group(s)</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{broadcast.message_type}</Badge>
                    </TableCell>
                    <TableCell>
                      {adminViewUserId ? (
                        <span className="text-xs text-gray-400">Read-only</span>
                      ) : editingId === broadcast.id ? (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleSaveEdit(broadcast.id)}
                            className="text-green-600 hover:text-green-700"
                          >
                            <CheckCircle className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleCancelEdit}
                            className="text-gray-600 hover:text-gray-700"
                          >
                            <XCircle className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : broadcast.status === 'pending' ? (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleStartEdit(broadcast)}
                            title="Reschedule"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleCancel(broadcast.id)}
                            className="text-red-600 hover:text-red-700"
                            title="Cancel"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">No actions</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
