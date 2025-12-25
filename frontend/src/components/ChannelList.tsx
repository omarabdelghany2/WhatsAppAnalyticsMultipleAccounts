import { Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { Channel } from "../lib/api";

interface ChannelListProps {
  channels: Channel[];
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  translateMode: boolean;
}

export function ChannelList({ channels, selectedChannelId, onSelectChannel, translateMode }: ChannelListProps) {
  return (
    <div className="h-full border-r border-border bg-card flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border space-y-3 flex-shrink-0">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Radio className="h-5 w-5" />
          {translateMode ? "频道" : "Channels"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {translateMode ? "您关注的频道" : "Channels you follow"}
        </p>
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
                "w-full border-b border-border transition-colors hover:bg-muted cursor-pointer",
                selectedChannelId === channel.id && "bg-primary/10 border-l-4 border-l-primary"
              )}
              onClick={() => onSelectChannel(channel.id)}
            >
              <div className="p-4">
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
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
