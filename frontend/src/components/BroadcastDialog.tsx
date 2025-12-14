import { useState, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Send,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  BarChart3,
  X,
  Plus,
  Trash2,
  Radio
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { ScrollArea } from './ui/scroll-area';

interface BroadcastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBroadcastSent?: () => void;
}

interface WhatsAppGroup {
  id: string;
  name: string;
  isGroup: boolean;
}

export function BroadcastDialog({ open, onOpenChange, onBroadcastSent }: BroadcastDialogProps) {
  const [message, setMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [messageType, setMessageType] = useState<'text' | 'poll'>('text');
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [allowMultipleAnswers, setAllowMultipleAnswers] = useState(false);
  const [gapTime, setGapTime] = useState(10); // Default 10 seconds
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [allGroups, setAllGroups] = useState<WhatsAppGroup[]>([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [broadcastProgress, setBroadcastProgress] = useState<{ current: number; total: number } | null>(null);
  const [broadcastMode, setBroadcastMode] = useState<'now' | 'schedule'>('now');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  // Load all groups when dialog opens
  useEffect(() => {
    if (open) {
      loadAllGroups();
    }
  }, [open]);

  const loadAllGroups = async () => {
    setIsLoadingGroups(true);
    try {
      const result = await api.getAllChats();
      if (result.success) {
        setAllGroups(result.groups);
      } else {
        toast.error('Failed to load groups');
      }
    } catch (error) {
      console.error('Error loading groups:', error);
      toast.error('Failed to load groups');
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);

    // Create preview for images
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
    if (documentInputRef.current) documentInputRef.current.value = '';
  };

  const toggleGroupSelection = (groupId: string) => {
    const newSelection = new Set(selectedGroups);
    if (newSelection.has(groupId)) {
      newSelection.delete(groupId);
    } else {
      newSelection.add(groupId);
    }
    setSelectedGroups(newSelection);
  };

  const selectAllGroups = () => {
    setSelectedGroups(new Set(allGroups.map(g => g.id)));
  };

  const deselectAllGroups = () => {
    setSelectedGroups(new Set());
  };

  const handleBroadcast = async () => {
    if (selectedGroups.size === 0) {
      toast.error('Please select at least one group');
      return;
    }

    if (messageType === 'text' && !message.trim() && !selectedFile) {
      toast.error('Please enter a message or select a file');
      return;
    }

    if (messageType === 'poll') {
      const validOptions = pollOptions.filter(opt => opt.trim() !== '');
      if (!pollQuestion.trim()) {
        toast.error('Please enter a poll question');
        return;
      }
      if (validOptions.length < 2) {
        toast.error('Poll must have at least 2 options');
        return;
      }
    }

    if (gapTime < 10) {
      toast.error('Gap time must be at least 10 seconds');
      return;
    }

    // Validate scheduling
    if (broadcastMode === 'schedule') {
      if (!scheduledDate || !scheduledTime) {
        toast.error('Please select both date and time for scheduled broadcast');
        return;
      }

      const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}`);
      const now = new Date();

      if (scheduledDateTime <= now) {
        toast.error('Scheduled time must be in the future');
        return;
      }
    }

    setIsSending(true);
    const totalGroups = selectedGroups.size;
    const messageContent = messageType === 'poll' ? pollQuestion : message;
    const pollOpts = messageType === 'poll' ? pollOptions.filter(opt => opt.trim() !== '') : undefined;

    try {
      let result;

      if (broadcastMode === 'schedule') {
        // Schedule the broadcast
        const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}`);

        result = await api.schedulebroadcast(
          Array.from(selectedGroups),
          messageContent,
          scheduledDateTime.toISOString(),
          selectedFile || undefined,
          messageType,
          pollOpts,
          gapTime,
          allowMultipleAnswers
        );

        if (result.success) {
          toast.success(result.message || `Broadcast scheduled successfully`);

          // Reset form
          setMessage('');
          setPollQuestion('');
          setPollOptions(['', '']);
          setAllowMultipleAnswers(false);
          setMessageType('text');
          handleRemoveFile();
          setSelectedGroups(new Set());
          setGapTime(10);
          setBroadcastMode('now');
          setScheduledDate('');
          setScheduledTime('');
          onOpenChange(false);
          onBroadcastSent?.();
        } else {
          toast.error(result.error || 'Failed to schedule broadcast');
        }
      } else {
        // Send immediately
        // Start at 1 since first message sends immediately
        setBroadcastProgress({ current: 1, total: totalGroups });

        // Simulate progress based on gap time
        let currentProgress = 1;
        const progressInterval = setInterval(() => {
          currentProgress++;
          if (currentProgress <= totalGroups) {
            setBroadcastProgress({ current: currentProgress, total: totalGroups });
          }
        }, gapTime * 1000);

        result = await api.broadcastMessage(
          Array.from(selectedGroups),
          messageContent,
          selectedFile || undefined,
          messageType,
          pollOpts,
          gapTime,
          allowMultipleAnswers
        );

        clearInterval(progressInterval);
        // Ensure we show completion
        setBroadcastProgress({ current: totalGroups, total: totalGroups });

        if (result.success) {
          toast.success(result.message || `Broadcast sent to ${result.totalSent} group(s)`);
          if (result.totalFailed > 0) {
            toast.warning(`${result.totalFailed} group(s) failed`);
          }

          // Reset form
          setMessage('');
          setPollQuestion('');
          setPollOptions(['', '']);
          setAllowMultipleAnswers(false);
          setMessageType('text');
          handleRemoveFile();
          setSelectedGroups(new Set());
          setGapTime(10);
          setBroadcastProgress(null);
          onOpenChange(false);
          onBroadcastSent?.();
        } else {
          toast.error(result.error || 'Failed to broadcast message');
          setBroadcastProgress(null);
        }
      }
    } catch (error) {
      console.error('Error broadcasting:', error);
      toast.error('Failed to broadcast message');
      setBroadcastProgress(null);
    } finally {
      setIsSending(false);
    }
  };

  const handleAddPollOption = () => {
    setPollOptions([...pollOptions, '']);
  };

  const handleRemovePollOption = (index: number) => {
    if (pollOptions.length <= 2) {
      toast.error('Poll must have at least 2 options');
      return;
    }
    setPollOptions(pollOptions.filter((_, i) => i !== index));
  };

  const handlePollOptionChange = (index: number, value: string) => {
    const newOptions = [...pollOptions];
    newOptions[index] = value;
    setPollOptions(newOptions);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      // Prevent closing dialog while broadcasting
      if (!isOpen && isSending) return;
      onOpenChange(isOpen);
    }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Broadcast Message</DialogTitle>
          <DialogDescription>
            Send a message to multiple groups at once with custom delay between sends
          </DialogDescription>
        </DialogHeader>

        {/* Progress Indicator */}
        {broadcastProgress && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
                Broadcasting...
              </span>
              <span className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                {broadcastProgress.current} / {broadcastProgress.total}
              </span>
            </div>
            <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2.5">
              <div
                className="bg-blue-600 dark:bg-blue-400 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${(broadcastProgress.current / broadcastProgress.total) * 100}%` }}
              ></div>
            </div>
            <p className="text-xs text-blue-700 dark:text-blue-300">
              Sent to {broadcastProgress.current} of {broadcastProgress.total} group{broadcastProgress.total !== 1 ? 's' : ''}
            </p>
          </div>
        )}

        <div className="flex-1 overflow-auto space-y-4">
          {/* Group Selection */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <Label>Select Groups ({selectedGroups.size} selected)</Label>
              <div className="space-x-2">
                <Button variant="outline" size="sm" onClick={selectAllGroups} disabled={isLoadingGroups}>
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={deselectAllGroups} disabled={isLoadingGroups}>
                  Deselect All
                </Button>
              </div>
            </div>
            <ScrollArea className="h-40 border rounded-md p-2">
              {isLoadingGroups ? (
                <p className="text-sm text-gray-500 text-center py-4">Loading groups...</p>
              ) : allGroups.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No groups found</p>
              ) : (
                <div className="space-y-2">
                  {allGroups.map((group) => (
                    <div key={group.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={group.id}
                        checked={selectedGroups.has(group.id)}
                        onCheckedChange={() => toggleGroupSelection(group.id)}
                      />
                      <label
                        htmlFor={group.id}
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        {group.name}
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Gap Time */}
          <div>
            <Label htmlFor="gapTime">Gap Time Between Messages (seconds, minimum 10)</Label>
            <Input
              id="gapTime"
              type="number"
              min={10}
              value={gapTime}
              onChange={(e) => setGapTime(Math.max(10, parseInt(e.target.value) || 10))}
              className="mt-1"
            />
            <p className="text-xs text-gray-500 mt-1">
              Total estimated time: ~{Math.ceil((selectedGroups.size * gapTime) / 60)} minute(s)
            </p>
          </div>

          {/* Broadcast Mode Selector */}
          <div>
            <Label>Broadcast Mode</Label>
            <div className="flex gap-2 mt-1">
              <Button
                variant={broadcastMode === 'now' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setBroadcastMode('now')}
              >
                Send Now
              </Button>
              <Button
                variant={broadcastMode === 'schedule' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setBroadcastMode('schedule')}
              >
                Schedule
              </Button>
            </div>
          </div>

          {/* Scheduling Date/Time */}
          {broadcastMode === 'schedule' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="scheduledDate">Scheduled Date</Label>
                <Input
                  id="scheduledDate"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="mt-1"
                  min={new Date().toISOString().split('T')[0]}
                />
              </div>
              <div>
                <Label htmlFor="scheduledTime">Scheduled Time</Label>
                <Input
                  id="scheduledTime"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="mt-1"
                />
              </div>
              {scheduledDate && scheduledTime && (
                <p className="text-sm text-blue-600 dark:text-blue-400">
                  Broadcast will be sent on {new Date(`${scheduledDate}T${scheduledTime}`).toLocaleString()}
                </p>
              )}
            </div>
          )}

          {/* Message Type Selector */}
          <div>
            <Label>Message Type</Label>
            <div className="flex gap-2 mt-1">
              <Button
                variant={messageType === 'text' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMessageType('text')}
              >
                <FileText className="h-4 w-4 mr-2" />
                Text/Media
              </Button>
              <Button
                variant={messageType === 'poll' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMessageType('poll')}
              >
                <Radio className="h-4 w-4 mr-2" />
                Poll
              </Button>
            </div>
          </div>

          {/* File Preview */}
          {selectedFile && messageType === 'text' && (
            <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
              {filePreview ? (
                <img src={filePreview} alt="Preview" className="h-16 w-16 object-cover rounded" />
              ) : (
                <div className="h-16 w-16 bg-gray-200 dark:bg-gray-600 rounded flex items-center justify-center">
                  <FileText className="h-8 w-8 text-gray-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                <p className="text-xs text-gray-500">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemoveFile}
                className="text-red-500 hover:text-red-700"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Message Content */}
          {messageType === 'text' ? (
            <>
              <div className="flex gap-1 mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={isSending}
                  title="Attach image"
                >
                  <ImageIcon className="h-5 w-5" />
                </Button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                />

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => videoInputRef.current?.click()}
                  disabled={isSending}
                  title="Attach video"
                >
                  <Video className="h-5 w-5" />
                </Button>
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                />

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => documentInputRef.current?.click()}
                  disabled={isSending}
                  title="Attach document"
                >
                  <Paperclip className="h-5 w-5" />
                </Button>
                <input
                  ref={documentInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                />
              </div>
              <div>
                <Label htmlFor="message">Message</Label>
                <Textarea
                  id="message"
                  placeholder="Type your message..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={isSending}
                  className="mt-1 min-h-[100px]"
                />
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <Label htmlFor="pollQuestion">Poll Question</Label>
                <Input
                  id="pollQuestion"
                  placeholder="What's your question?"
                  value={pollQuestion}
                  onChange={(e) => setPollQuestion(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Poll Options</Label>
                <div className="space-y-2 mt-1">
                  {pollOptions.map((option, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        placeholder={`Option ${index + 1}`}
                        value={option}
                        onChange={(e) => handlePollOptionChange(index, e.target.value)}
                      />
                      {pollOptions.length > 2 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemovePollOption(index)}
                          className="text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddPollOption}
                  className="mt-2 w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Option
                </Button>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="allowMultipleBroadcast"
                  checked={allowMultipleAnswers}
                  onCheckedChange={(checked) => setAllowMultipleAnswers(checked as boolean)}
                />
                <label
                  htmlFor="allowMultipleBroadcast"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                >
                  Allow multiple answers
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSending}>
            Cancel
          </Button>
          <Button onClick={handleBroadcast} disabled={isSending || selectedGroups.size === 0}>
            {broadcastProgress
              ? `Broadcasting... (${broadcastProgress.current}/${broadcastProgress.total})`
              : isSending
              ? broadcastMode === 'schedule' ? 'Scheduling...' : 'Starting...'
              : broadcastMode === 'schedule'
              ? `Schedule for ${selectedGroups.size} Group(s)`
              : `Broadcast to ${selectedGroups.size} Group(s)`
            }
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
