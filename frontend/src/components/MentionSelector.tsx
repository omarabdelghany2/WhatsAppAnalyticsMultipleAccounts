import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Loader2, UserCheck, Search, X } from 'lucide-react';
import { Input } from './ui/input';
import { api } from '../lib/api';
import { toast } from 'sonner';

interface GroupMember {
  id: string;
  name: string;
  phone: string;
  isAdmin: boolean;
}

interface MentionSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  onMentionsSelected: (mentions: string[], memberNames: string[]) => void;
}

export function MentionSelector({ open, onOpenChange, groupId, onMentionsSelected }: MentionSelectorProps) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open && groupId) {
      fetchMembers();
    }
  }, [open, groupId]);

  const fetchMembers = async () => {
    setLoading(true);
    try {
      const response = await api.getGroupMembers(groupId);
      if (response.success) {
        setMembers(response.members);
      } else {
        toast.error(response.error || 'Failed to fetch group members');
      }
    } catch (error) {
      console.error('Error fetching members:', error);
      toast.error('Failed to fetch group members');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleMember = (memberId: string) => {
    const newSelected = new Set(selectedMembers);
    if (newSelected.has(memberId)) {
      newSelected.delete(memberId);
    } else {
      newSelected.add(memberId);
    }
    setSelectedMembers(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedMembers.size === filteredMembers.length) {
      setSelectedMembers(new Set());
    } else {
      setSelectedMembers(new Set(filteredMembers.map(m => m.id)));
    }
  };

  const handleConfirm = () => {
    const selectedMemberIds = Array.from(selectedMembers);
    const selectedMemberNames = members
      .filter(m => selectedMembers.has(m.id))
      .map(m => m.name);

    onMentionsSelected(selectedMemberIds, selectedMemberNames);
    setSelectedMembers(new Set());
    setSearchQuery('');
    onOpenChange(false);
  };

  const handleCancel = () => {
    setSelectedMembers(new Set());
    setSearchQuery('');
    onOpenChange(false);
  };

  const filteredMembers = members.filter(member =>
    member.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    member.phone.includes(searchQuery)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mention Group Members</DialogTitle>
          <DialogDescription>
            Select members to mention in your message
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search members..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-10"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Select All Button */}
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSelectAll}
                className="text-xs"
              >
                {selectedMembers.size === filteredMembers.length ? 'Deselect All' : 'Select All'}
              </Button>
              <span className="text-xs text-gray-500">
                {selectedMembers.size} of {filteredMembers.length} selected
              </span>
            </div>

            {/* Members List */}
            <ScrollArea className="h-[300px] border rounded-md">
              <div className="p-4 space-y-2">
                {filteredMembers.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No members found
                  </div>
                ) : (
                  filteredMembers.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center space-x-3 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                      onClick={() => handleToggleMember(member.id)}
                    >
                      <Checkbox
                        checked={selectedMembers.has(member.id)}
                        onCheckedChange={() => handleToggleMember(member.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">
                            {member.name}
                          </p>
                          {member.isAdmin && (
                            <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-2 py-0.5 rounded">
                              Admin
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500">{member.phone}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            {/* Action Buttons */}
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={selectedMembers.size === 0}
              >
                <UserCheck className="h-4 w-4 mr-2" />
                Mention ({selectedMembers.size})
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
