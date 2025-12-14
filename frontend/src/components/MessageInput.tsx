import { useState, useRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Checkbox } from './ui/checkbox';
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
  Radio,
  Calendar
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { toast } from 'sonner';
import { api } from '../lib/api';
import { BroadcastDialog } from './BroadcastDialog';
import { ScheduledBroadcastsDialog } from './ScheduledBroadcastsDialog';

interface MessageInputProps {
  groupId: string;
  onMessageSent?: () => void;
}

export function MessageInput({ groupId, onMessageSent }: MessageInputProps) {
  const [message, setMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [showPollDialog, setShowPollDialog] = useState(false);
  const [showBroadcastDialog, setShowBroadcastDialog] = useState(false);
  const [showScheduledBroadcastsDialog, setShowScheduledBroadcastsDialog] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [allowMultipleAnswers, setAllowMultipleAnswers] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

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

  const handleSendMessage = async () => {
    if (!message.trim() && !selectedFile) {
      toast.error('Please enter a message or select a file');
      return;
    }

    setIsSending(true);
    try {
      const result = await api.sendMessage(
        groupId,
        message,
        selectedFile || undefined,
        'text'
      );

      if (result.success) {
        toast.success('Message sent successfully');
        setMessage('');
        handleRemoveFile();
        onMessageSent?.();
      } else {
        toast.error(result.error || 'Failed to send message');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  const handleSendPoll = async () => {
    const validOptions = pollOptions.filter(opt => opt.trim() !== '');

    if (!pollQuestion.trim()) {
      toast.error('Please enter a poll question');
      return;
    }

    if (validOptions.length < 2) {
      toast.error('Poll must have at least 2 options');
      return;
    }

    setIsSending(true);
    try {
      const result = await api.sendMessage(
        groupId,
        pollQuestion,
        undefined,
        'poll',
        validOptions,
        allowMultipleAnswers
      );

      if (result.success) {
        toast.success('Poll sent successfully');
        setPollQuestion('');
        setPollOptions(['', '']);
        setAllowMultipleAnswers(false);
        setShowPollDialog(false);
        onMessageSent?.();
      } else {
        toast.error(result.error || 'Failed to send poll');
      }
    } catch (error) {
      console.error('Error sending poll:', error);
      toast.error('Failed to send poll');
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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="border-t bg-white dark:bg-gray-800 p-4 space-y-3">
      {/* File Preview */}
      {selectedFile && (
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

      {/* Message Input Area */}
      <div className="flex items-end gap-2">
        <div className="flex gap-1">
          {/* Image Upload */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => imageInputRef.current?.click()}
            disabled={isSending}
            title="Send image"
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

          {/* Video Upload */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => videoInputRef.current?.click()}
            disabled={isSending}
            title="Send video"
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

          {/* Document Upload */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => documentInputRef.current?.click()}
            disabled={isSending}
            title="Send document"
          >
            <Paperclip className="h-5 w-5" />
          </Button>
          <input
            ref={documentInputRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
          />

          {/* Broadcast Button */}
          <Button
            variant="ghost"
            size="sm"
            disabled={isSending}
            title="Broadcast to multiple groups"
            onClick={() => setShowBroadcastDialog(true)}
          >
            <Radio className="h-5 w-5" />
          </Button>

          {/* Scheduled Broadcasts Button */}
          <Button
            variant="ghost"
            size="sm"
            disabled={isSending}
            title="View scheduled broadcasts"
            onClick={() => setShowScheduledBroadcastsDialog(true)}
          >
            <Calendar className="h-5 w-5" />
          </Button>

          {/* Poll Dialog */}
          <Dialog open={showPollDialog} onOpenChange={setShowPollDialog}>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={isSending}
                title="Create poll"
              >
                <BarChart3 className="h-5 w-5" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a Poll</DialogTitle>
                <DialogDescription>
                  Ask a question and provide options for group members to vote
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Question</label>
                  <Input
                    placeholder="What's your question?"
                    value={pollQuestion}
                    onChange={(e) => setPollQuestion(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block">Options</label>
                  <div className="space-y-2">
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
                    id="allowMultiple"
                    checked={allowMultipleAnswers}
                    onCheckedChange={(checked) => setAllowMultipleAnswers(checked as boolean)}
                  />
                  <label
                    htmlFor="allowMultiple"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    Allow multiple answers
                  </label>
                </div>
                <Button
                  onClick={handleSendPoll}
                  disabled={isSending}
                  className="w-full"
                >
                  Send Poll
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Text Input */}
        <Textarea
          placeholder="Type a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={isSending}
          className="flex-1 min-h-[44px] max-h-32 resize-none"
          rows={1}
        />

        {/* Send Button */}
        <Button
          onClick={handleSendMessage}
          disabled={isSending || (!message.trim() && !selectedFile)}
          size="sm"
          className="h-11"
        >
          <Send className="h-5 w-5" />
        </Button>
      </div>

      {/* Broadcast Dialog */}
      <BroadcastDialog
        open={showBroadcastDialog}
        onOpenChange={setShowBroadcastDialog}
        onBroadcastSent={onMessageSent}
      />

      {/* Scheduled Broadcasts Dialog */}
      <ScheduledBroadcastsDialog
        open={showScheduledBroadcastsDialog}
        onOpenChange={setShowScheduledBroadcastsDialog}
      />
    </div>
  );
}
