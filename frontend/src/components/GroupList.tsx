import { useState } from "react";
import { Users, Plus, X, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { WelcomeMessageSettings } from "./WelcomeMessageSettings";

interface Group {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: string;
  unread: number;
  members: number;
}

interface GroupListProps {
  groups: Group[];
  selectedGroupId: string;
  onSelectGroup: (groupId: string) => void;
  onAddGroup: (name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  translateMode: boolean;
}

export function GroupList({ groups, selectedGroupId, onSelectGroup, onAddGroup, onDeleteGroup, translateMode }: GroupListProps) {
  const [newGroupName, setNewGroupName] = useState("");
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null);
  const [settingsGroupName, setSettingsGroupName] = useState<string>("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newGroupName.trim()) {
      onAddGroup(newGroupName.trim());
      setNewGroupName("");
    }
  };

  const handleOpenSettings = (groupId: string, groupName: string) => {
    setSettingsGroupId(groupId);
    setSettingsGroupName(groupName);
  };

  return (
    <div className="h-full border-r border-border bg-card flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border space-y-3 flex-shrink-0">
        <h2 className="text-lg font-semibold text-foreground">
          {translateMode ? "群组聊天" : "Group Chats"}
        </h2>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            type="text"
            placeholder={translateMode ? "群组名称" : "Group name"}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" size="icon">
            <Plus className="h-4 w-4" />
          </Button>
        </form>
      </div>
      <div className="overflow-y-auto" style={{ flex: '1 1 0', minHeight: 0 }}>
        {groups.map((group) => (
          <div
            key={group.id}
            className={cn(
              "w-full border-b border-border transition-colors hover:bg-muted relative group/item",
              selectedGroupId === group.id && "bg-primary/10 border-l-4 border-l-primary"
            )}
          >
            <button
              onClick={() => onSelectGroup(group.id)}
              className="w-full p-4 pr-12 text-left"
            >
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-semibold text-foreground truncate">{group.name}</h3>
                <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                  {group.timestamp}
                </span>
              </div>
              <p className="text-sm text-muted-foreground truncate mb-2">{group.lastMessage}</p>
              <div className="flex items-center justify-between">
                <div className="flex items-center text-xs text-muted-foreground">
                  <Users className="h-3 w-3 mr-1" />
                  {group.members}
                </div>
                {group.unread > 0 && (
                  <span className="bg-primary text-primary-foreground text-xs rounded-full px-2 py-0.5 font-medium">
                    {group.unread}
                  </span>
                )}
              </div>
            </button>
            <div className="absolute right-2 top-2 flex gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenSettings(group.id, group.name);
                }}
                title="Welcome message settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteGroup(group.id);
                }}
                title="Remove group"
              >
                <X className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Welcome Message Settings Dialog */}
      {settingsGroupId && (
        <WelcomeMessageSettings
          open={settingsGroupId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSettingsGroupId(null);
              setSettingsGroupName("");
            }
          }}
          groupId={settingsGroupId}
          groupName={settingsGroupName}
        />
      )}
    </div>
  );
}
