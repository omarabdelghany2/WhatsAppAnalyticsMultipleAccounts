import { useState } from "react";
import { Radio, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Channel } from "../lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface ChannelListProps {
  channels: Channel[];
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onAddChannel: (name: string) => void;
  onDeleteChannel: (channelId: string) => void;
  translateMode: boolean;
}

export function ChannelList({ channels, selectedChannelId, onSelectChannel, onAddChannel, onDeleteChannel, translateMode }: ChannelListProps) {
  const [newChannelName, setNewChannelName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newChannelName.trim()) {
      onAddChannel(newChannelName.trim());
      setNewChannelName("");
    }
  };

  return (
    <div className="h-full border-r border-border bg-card flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border space-y-3 flex-shrink-0">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Radio className="h-5 w-5" />
          {translateMode ? "频道" : "Channels"}
        </h2>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            type="text"
            placeholder={translateMode ? "频道名称" : "Channel name"}
            value={newChannelName}
            onChange={(e) => setNewChannelName(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" size="icon">
            <Plus className="h-4 w-4" />
          </Button>
        </form>
      </div>

      <div className="overflow-y-auto" style={{ flex: '1 1 0', minHeight: 0 }}>
        {channels.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            <Radio className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {translateMode ? "未找到频道" : "No channels found"}
            </p>
            <p className="text-xs mt-1">
              {translateMode ? "在移动设备上订阅频道" : "Subscribe to channels on mobile"}
            </p>
          </div>
        ) : (
          channels.map((channel) => (
            <div
              key={channel.id}
              className={cn(
                "w-full border-b border-border transition-colors hover:bg-muted relative group/item",
                selectedChannelId === channel.id && "bg-primary/10 border-l-4 border-l-primary"
              )}
            >
              <button
                onClick={() => onSelectChannel(channel.id)}
                className="w-full p-4 pr-20 text-left"
              >
                <div className="flex items-start justify-between mb-1">
                  <h3 className="font-semibold text-foreground truncate pr-2 flex items-center gap-2">
                    <Radio className="h-4 w-4 flex-shrink-0" />
                    {channel.name}
                  </h3>
                </div>
                {channel.description && (
                  <p className="text-sm text-muted-foreground truncate mb-2">
                    {channel.description}
                  </p>
                )}
                <div className="flex items-center text-xs text-muted-foreground">
                  <span>
                    {channel.subscriberCount.toLocaleString()} {translateMode ? "订阅者" : "subscribers"}
                  </span>
                </div>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover/item:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteChannel(channel.id);
                }}
                title={translateMode ? "停止监控此频道" : "Stop monitoring this channel"}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
