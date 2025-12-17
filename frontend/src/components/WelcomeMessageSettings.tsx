import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Loader2, Save, Trash2, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';

interface WelcomeMessageSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
}

export function WelcomeMessageSettings({ open, onOpenChange, groupId, groupName }: WelcomeMessageSettingsProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [messageText, setMessageText] = useState('Welcome to the group! 🎉');
  const [memberThreshold, setMemberThreshold] = useState(5);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [hasSettings, setHasSettings] = useState(false);

  useEffect(() => {
    if (open && groupId) {
      fetchSettings();
    }
  }, [open, groupId]);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const response = await api.getWelcomeSettings(groupId);
      if (response.success && response.settings) {
        setEnabled(response.settings.enabled === 1);
        setMessageText(response.settings.message_text);
        setMemberThreshold(response.settings.member_threshold);
        setDelayMinutes(response.settings.delay_minutes);
        setHasSettings(true);
      } else {
        // No settings found, use defaults
        setEnabled(false);
        setMessageText('Welcome to the group! 🎉');
        setMemberThreshold(5);
        setDelayMinutes(5);
        setHasSettings(false);
      }
    } catch (error) {
      console.error('Error fetching welcome settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!messageText.trim()) {
      toast.error('Please enter a welcome message');
      return;
    }

    if (memberThreshold < 1) {
      toast.error('Member threshold must be at least 1');
      return;
    }

    if (delayMinutes < 0) {
      toast.error('Delay time cannot be negative');
      return;
    }

    setSaving(true);
    try {
      const response = await api.saveWelcomeSettings(
        groupId,
        enabled,
        messageText,
        memberThreshold,
        delayMinutes
      );

      if (response.success) {
        toast.success(response.message);
        setHasSettings(true);
        onOpenChange(false);
      } else {
        toast.error(response.error || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving welcome settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!hasSettings) {
      toast.error('No settings to delete');
      return;
    }

    setDeleting(true);
    try {
      const response = await api.deleteWelcomeSettings(groupId);

      if (response.success) {
        toast.success(response.message);
        // Reset to defaults
        setEnabled(false);
        setMessageText('Welcome to the group! 🎉');
        setMemberThreshold(5);
        setDelayMinutes(5);
        setHasSettings(false);
        onOpenChange(false);
      } else {
        toast.error(response.error || 'Failed to delete settings');
      }
    } catch (error) {
      console.error('Error deleting welcome settings:', error);
      toast.error('Failed to delete settings');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Welcome Message Settings
          </DialogTitle>
          <DialogDescription>
            Configure automated welcome messages for <strong>{groupName}</strong>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="space-y-6 py-4">
            {/* Enable/Disable Switch */}
            <div className="flex items-center justify-between p-4 border rounded-lg bg-gray-50 dark:bg-gray-800">
              <div className="space-y-1">
                <Label htmlFor="enabled" className="text-base font-semibold">
                  Enable Welcome Messages
                </Label>
                <p className="text-sm text-gray-500">
                  Automatically send welcome messages to new members
                </p>
              </div>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {/* Welcome Message Text */}
            <div className="space-y-2">
              <Label htmlFor="messageText" className="text-sm font-medium">
                Welcome Message
              </Label>
              <Textarea
                id="messageText"
                placeholder="Enter your welcome message..."
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-gray-500">
                New members will be automatically mentioned after this text
              </p>
            </div>

            {/* Member Threshold */}
            <div className="space-y-2">
              <Label htmlFor="memberThreshold" className="text-sm font-medium">
                Number of Members
              </Label>
              <Input
                id="memberThreshold"
                type="number"
                min="1"
                value={memberThreshold}
                onChange={(e) => setMemberThreshold(parseInt(e.target.value) || 1)}
              />
              <p className="text-xs text-gray-500">
                Send welcome message after this many people join
              </p>
            </div>

            {/* Delay Time */}
            <div className="space-y-2">
              <Label htmlFor="delayMinutes" className="text-sm font-medium">
                Delay Time (minutes)
              </Label>
              <Input
                id="delayMinutes"
                type="number"
                min="0"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(parseInt(e.target.value) || 0)}
              />
              <p className="text-xs text-gray-500">
                Wait this many minutes after members join before sending the message
              </p>
            </div>

            {/* Example Preview */}
            <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20">
              <p className="text-sm font-semibold text-blue-700 dark:text-blue-300 mb-2">
                Example Preview:
              </p>
              <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <p>{messageText}</p>
                <p className="text-blue-600 dark:text-blue-400">@201234567890 @209876543210 @201122334455</p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex justify-between items-center">
          <div>
            {hasSettings && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleting || loading || saving}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete Settings
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving || deleting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || loading || deleting}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Settings
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
