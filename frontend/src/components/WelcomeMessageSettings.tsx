import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Checkbox } from './ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Loader2, Save, Trash2, Settings, Image as ImageIcon, X, AtSign } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';

interface WelcomeMessageSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  translateMode?: boolean;
}

export function WelcomeMessageSettings({ open, onOpenChange, groupId, groupName, translateMode = false }: WelcomeMessageSettingsProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [messageText, setMessageText] = useState('Welcome to the group! 🎉');
  const [memberThreshold, setMemberThreshold] = useState(5);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [hasSettings, setHasSettings] = useState(false);

  // Image settings
  const [imageEnabled, setImageEnabled] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Specific mentions
  const [specificMentions, setSpecificMentions] = useState<string[]>([]);
  const [specificMentionNames, setSpecificMentionNames] = useState<string[]>([]);
  const [showMemberSelector, setShowMemberSelector] = useState(false);
  const [groupMembers, setGroupMembers] = useState<Array<{id: string, name: string, phone: string, isAdmin: boolean}>>([]);

  useEffect(() => {
    if (open && groupId) {
      fetchSettings();
      fetchGroupMembers();
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
        setImageEnabled(response.settings.image_enabled === 1);
        setImageCaption(response.settings.image_caption || '');

        // Handle existing image
        if (response.settings.image_data) {
          const imageUrl = `data:${response.settings.image_mimetype};base64,${response.settings.image_data}`;
          setImagePreview(imageUrl);
        }

        // Parse specific mentions
        if (response.settings.specific_mentions) {
          try {
            const mentions = JSON.parse(response.settings.specific_mentions);
            setSpecificMentions(mentions);
          } catch (err) {
            console.error('Error parsing specific mentions:', err);
          }
        }

        setHasSettings(true);
      } else {
        // No settings found, use defaults
        setEnabled(false);
        setMessageText(translateMode ? '欢迎加入群组！🎉' : 'Welcome to the group! 🎉');
        setMemberThreshold(5);
        setDelayMinutes(5);
        setImageEnabled(false);
        setImageCaption('');
        setImagePreview(null);
        setSpecificMentions([]);
        setHasSettings(false);
      }
    } catch (error) {
      console.error('Error fetching welcome settings:', error);
      toast.error(translateMode ? '加载设置失败' : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const fetchGroupMembers = async () => {
    setLoadingMembers(true);
    try {
      const response = await api.getGroupMembers(groupId);
      console.log('👥 Loaded group members:', response.members?.length);
      if (response.success) {
        setGroupMembers(response.members);
      }
    } catch (error) {
      console.error('Error fetching group members:', error);
    } finally {
      setLoadingMembers(false);
    }
  };

  // Separate useEffect to update names when both members and mentions are loaded
  useEffect(() => {
    if (groupMembers.length > 0 && specificMentions.length > 0) {
      const names = specificMentions.map(mentionId => {
        const member = groupMembers.find(m => m.id === mentionId);
        return member ? member.name : mentionId;
      });
      setSpecificMentionNames(names);
      console.log('✅ Updated specific mention names:', names);
    }
  }, [groupMembers, specificMentions]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error(translateMode ? '请选择图片文件' : 'Please select an image file');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error(translateMode ? '图片大小必须小于5MB' : 'Image size must be less than 5MB');
      return;
    }

    setImageFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setImagePreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!messageText.trim()) {
      toast.error(translateMode ? '请输入欢迎消息' : 'Please enter a welcome message');
      return;
    }

    if (memberThreshold < 1) {
      toast.error(translateMode ? '成员阈值必须至少为1' : 'Member threshold must be at least 1');
      return;
    }

    if (delayMinutes < 0) {
      toast.error(translateMode ? '延迟时间不能为负数' : 'Delay time cannot be negative');
      return;
    }

    console.log('🔍 Saving welcome settings with specificMentions:', specificMentions);
    console.log('🔍 Specific mention names:', specificMentionNames);

    setSaving(true);
    try {
      const response = await api.saveWelcomeSettings(
        groupId,
        enabled,
        messageText,
        memberThreshold,
        delayMinutes,
        imageEnabled,
        imageFile,
        imageCaption,
        specificMentions
      );

      if (response.success) {
        toast.success(response.message);
        setHasSettings(true);
        onOpenChange(false);
      } else {
        toast.error(response.error || (translateMode ? '保存设置失败' : 'Failed to save settings'));
      }
    } catch (error) {
      console.error('Error saving welcome settings:', error);
      toast.error(translateMode ? '保存设置失败' : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!hasSettings) {
      toast.error(translateMode ? '没有设置可删除' : 'No settings to delete');
      return;
    }

    setDeleting(true);
    try {
      const response = await api.deleteWelcomeSettings(groupId);

      if (response.success) {
        toast.success(response.message);
        // Reset to defaults
        setEnabled(false);
        setMessageText(translateMode ? '欢迎加入群组！🎉' : 'Welcome to the group! 🎉');
        setMemberThreshold(5);
        setDelayMinutes(5);
        setImageEnabled(false);
        setImageFile(null);
        setImagePreview(null);
        setImageCaption('');
        setSpecificMentions([]);
        setSpecificMentionNames([]);
        setHasSettings(false);
        onOpenChange(false);
      } else {
        toast.error(response.error || (translateMode ? '删除设置失败' : 'Failed to delete settings'));
      }
    } catch (error) {
      console.error('Error deleting welcome settings:', error);
      toast.error(translateMode ? '删除设置失败' : 'Failed to delete settings');
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
            {translateMode ? '欢迎消息设置' : 'Welcome Message Settings'}
          </DialogTitle>
          <DialogDescription>
            {translateMode ? (
              <>为 <strong>{groupName}</strong> 配置自动欢迎消息</>
            ) : (
              <>Configure automated welcome messages for <strong>{groupName}</strong></>
            )}
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
                  {translateMode ? '启用欢迎消息' : 'Enable Welcome Messages'}
                </Label>
                <p className="text-sm text-gray-500">
                  {translateMode ? '自动向新成员发送欢迎消息' : 'Automatically send welcome messages to new members'}
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
                {translateMode ? '欢迎消息' : 'Welcome Message'}
              </Label>
              <Textarea
                id="messageText"
                placeholder={translateMode ? '输入您的欢迎消息...' : 'Enter your welcome message...'}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-gray-500">
                {translateMode ? '新成员将在顶部被提及，然后是此消息，特定提及将在底部' : 'New members will be mentioned at the TOP, then this message, then specific mentions at the BOTTOM'}
              </p>
            </div>

            {/* Specific Mentions */}
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-2">
                <AtSign className="h-4 w-4" />
                {translateMode ? '特定提及（始终提及）' : 'Specific Mentions (Always Mentioned)'}
              </Label>
              <p className="text-xs text-gray-500 mb-2">
                {translateMode ? '选择要在欢迎消息底部始终提及的成员' : 'Select members to always mention at the bottom of the welcome message'}
              </p>
              {specificMentionNames.length > 0 && (
                <div className="flex flex-wrap gap-2 p-2 border rounded-lg bg-gray-50 dark:bg-gray-800">
                  {specificMentionNames.map((name, index) => (
                    <div key={index} className="flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900 rounded text-sm">
                      <span>{name}</span>
                      <button
                        onClick={() => {
                          const newMentions = [...specificMentions];
                          const newNames = [...specificMentionNames];
                          newMentions.splice(index, 1);
                          newNames.splice(index, 1);
                          setSpecificMentions(newMentions);
                          setSpecificMentionNames(newNames);
                        }}
                        className="text-blue-600 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowMemberSelector(true)}
                disabled={loadingMembers}
                className="w-full"
              >
                <AtSign className="h-4 w-4 mr-2" />
                {translateMode ?
                  (specificMentionNames.length > 0 ? '更改成员' : '选择成员') :
                  (specificMentionNames.length > 0 ? 'Change Members' : 'Select Members')
                }
              </Button>
            </div>

            {/* Image Message Section */}
            <div className="space-y-4 p-4 border rounded-lg">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="imageEnabled" className="text-base font-semibold flex items-center gap-2">
                    <ImageIcon className="h-4 w-4" />
                    {translateMode ? '第二条消息（图片）' : 'Second Message (Image)'}
                  </Label>
                  <p className="text-sm text-gray-500">
                    {translateMode ? '在欢迎文字后发送带标题的可选图片' : 'Send an optional image with caption after the welcome text'}
                  </p>
                </div>
                <Switch
                  id="imageEnabled"
                  checked={imageEnabled}
                  onCheckedChange={setImageEnabled}
                />
              </div>

              {imageEnabled && (
                <div className="space-y-4 pt-4 border-t">
                  {/* Image Upload */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">{translateMode ? '图片' : 'Image'}</Label>
                    {imagePreview ? (
                      <div className="relative">
                        <img
                          src={imagePreview}
                          alt={translateMode ? '欢迎图片预览' : 'Welcome image preview'}
                          className="w-full max-h-64 object-contain rounded-lg border"
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveImage}
                          className="absolute top-2 right-2"
                        >
                          <X className="h-4 w-4 mr-1" />
                          {translateMode ? '移除' : 'Remove'}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6">
                        <ImageIcon className="h-12 w-12 text-gray-400 mb-2" />
                        <p className="text-sm text-gray-500 mb-2">
                          {translateMode ? '点击上传图片（最大5MB）' : 'Click to upload an image (max 5MB)'}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => imageInputRef.current?.click()}
                        >
                          {translateMode ? '选择图片' : 'Choose Image'}
                        </Button>
                      </div>
                    )}
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleImageSelect}
                    />
                  </div>

                  {/* Image Caption */}
                  <div className="space-y-2">
                    <Label htmlFor="imageCaption" className="text-sm font-medium">
                      {translateMode ? '图片标题（可选）' : 'Image Caption (Optional)'}
                    </Label>
                    <Textarea
                      id="imageCaption"
                      placeholder={translateMode ? '输入图片标题...' : 'Enter caption for the image...'}
                      value={imageCaption}
                      onChange={(e) => setImageCaption(e.target.value)}
                      rows={3}
                      className="resize-none"
                    />
                    <p className="text-xs text-gray-500">
                      {translateMode ? '特定提及可以包含在标题中' : 'Specific mentions can be included in the caption'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Member Threshold */}
            <div className="space-y-2">
              <Label htmlFor="memberThreshold" className="text-sm font-medium">
                {translateMode ? '成员数量' : 'Number of Members'}
              </Label>
              <Input
                id="memberThreshold"
                type="number"
                min="1"
                value={memberThreshold}
                onChange={(e) => setMemberThreshold(parseInt(e.target.value) || 1)}
              />
              <p className="text-xs text-gray-500">
                {translateMode ? '在这么多人加入后发送欢迎消息' : 'Send welcome message after this many people join'}
              </p>
            </div>

            {/* Delay Time */}
            <div className="space-y-2">
              <Label htmlFor="delayMinutes" className="text-sm font-medium">
                {translateMode ? '延迟时间（分钟）' : 'Delay Time (minutes)'}
              </Label>
              <Input
                id="delayMinutes"
                type="number"
                min="0"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(parseInt(e.target.value) || 0)}
              />
              <p className="text-xs text-gray-500">
                {translateMode ? '成员加入后等待这么多分钟再发送消息' : 'Wait this many minutes after members join before sending the message'}
              </p>
            </div>

            {/* Example Preview */}
            <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20">
              <p className="text-sm font-semibold text-blue-700 dark:text-blue-300 mb-2">
                {translateMode ? '示例预览：' : 'Example Preview:'}
              </p>
              <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
                <p className="text-blue-600 dark:text-blue-400">@201234567890 @209876543210 @201122334455</p>
                <p className="whitespace-pre-wrap">{messageText}</p>
                {specificMentionNames.length > 0 && (
                  <p className="text-green-600 dark:text-green-400">
                    @{specificMentionNames.join(' @')}
                  </p>
                )}
                {imageEnabled && (
                  <p className="text-xs text-purple-600 dark:text-purple-400 mt-2 pt-2 border-t border-blue-200 dark:border-blue-700">
                    {translateMode ? '📷 第二条消息：将发送带标题的图片' : '📷 Second message: Image with caption will be sent'}
                  </p>
                )}
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
                {translateMode ? '删除设置' : 'Delete Settings'}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving || deleting}
            >
              {translateMode ? '取消' : 'Cancel'}
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
              {translateMode ? '保存设置' : 'Save Settings'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      {/* Member Selector Dialog */}
      {showMemberSelector && (
        <Dialog open={showMemberSelector} onOpenChange={setShowMemberSelector}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{translateMode ? '选择要提及的成员' : 'Select Members to Mention'}</DialogTitle>
              <DialogDescription>
                {translateMode ? '选择要在欢迎消息中始终提及的成员' : 'Choose members to always mention in welcome messages'}
              </DialogDescription>
            </DialogHeader>
            {loadingMembers ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
              </div>
            ) : groupMembers.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                {translateMode ? '未找到群组成员' : 'No group members found'}
              </div>
            ) : (
              <div className="space-y-2">
                {groupMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center space-x-2 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                >
                  <Checkbox
                    id={`member-${member.id}`}
                    checked={specificMentions.includes(member.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        const newMentions = [...specificMentions, member.id];
                        const newNames = [...specificMentionNames, member.name];
                        console.log(`✅ Added member ${member.name} (${member.id})`);
                        console.log('New mentions:', newMentions);
                        setSpecificMentions(newMentions);
                        setSpecificMentionNames(newNames);
                      } else {
                        const index = specificMentions.indexOf(member.id);
                        const newMentions = [...specificMentions];
                        const newNames = [...specificMentionNames];
                        newMentions.splice(index, 1);
                        newNames.splice(index, 1);
                        console.log(`❌ Removed member ${member.name} (${member.id})`);
                        console.log('New mentions:', newMentions);
                        setSpecificMentions(newMentions);
                        setSpecificMentionNames(newNames);
                      }
                    }}
                  />
                  <label
                    htmlFor={`member-${member.id}`}
                    className="flex-1 text-sm cursor-pointer"
                  >
                    {member.name}
                    {member.isAdmin && (
                      <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">
                        {translateMode ? '（管理员）' : '(Admin)'}
                      </span>
                    )}
                  </label>
                </div>
              ))}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowMemberSelector(false)}
              >
                {translateMode ? '取消' : 'Cancel'}
              </Button>
              <Button onClick={() => setShowMemberSelector(false)}>
                {translateMode ? `完成（已选择 ${specificMentions.length} 个）` : `Done (${specificMentions.length} selected)`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
