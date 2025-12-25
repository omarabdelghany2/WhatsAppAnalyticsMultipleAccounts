import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Heart, Image as ImageIcon, Video, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { PollMessage } from "./PollMessage";

interface ChannelMessage {
  id: string;
  channelId: string;
  channelName: string;
  content: string;
  mediaType: 'text' | 'image' | 'video' | 'document' | 'poll';
  timestamp: number;
  hasMedia: boolean;
  forwardingScore: number;
  reactions?: any[];
  pollData?: {
    pollName: string;
    pollOptions: Array<{ name: string; localId: number }>;
    votes: any[];
  };
}

interface ChannelViewProps {
  messages: ChannelMessage[];
  channelName: string;
  channelId: string;
  onReactionClick?: (messageId: string) => void;
}

export function ChannelView({ messages, channelName, channelId, onReactionClick }: ChannelViewProps) {
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);

  // Check if user is at bottom
  const checkIfAtBottom = () => {
    if (scrollViewportRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollViewportRef.current;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsAtBottom(atBottom);
    }
  };

  // Auto-scroll to bottom only if user was already at bottom
  useEffect(() => {
    if (scrollViewportRef.current && isAtBottom) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
  }, [messages, isAtBottom]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
  }, [channelId]);

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const renderMediaIcon = (mediaType: string) => {
    switch (mediaType) {
      case 'image':
        return <ImageIcon className="h-4 w-4 inline mr-1" />;
      case 'video':
        return <Video className="h-4 w-4 inline mr-1" />;
      case 'document':
        return <FileText className="h-4 w-4 inline mr-1" />;
      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col bg-chat-bg">
      <div className="p-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <span className="text-xl">📡</span>
          {channelName}
        </h2>
      </div>
      <div className="flex-1 overflow-hidden" style={{ flex: '1 1 0', minHeight: 0 }}>
        <div
          ref={scrollViewportRef}
          onScroll={checkIfAtBottom}
          className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200"
        >
          <div className="space-y-4">
            {messages.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No messages in this channel yet</p>
              </div>
            ) : (
              messages.map((message) => {
                const isHovered = hoveredMessageId === message.id;
                const hasReactions = message.reactions && message.reactions.length > 0;

                return (
                  <div
                    key={message.id}
                    className="flex gap-2 items-start justify-start"
                    onMouseEnter={() => setHoveredMessageId(message.id)}
                    onMouseLeave={() => setHoveredMessageId(null)}
                  >
                    {/* Reaction button */}
                    <div className="flex gap-1">
                      {onReactionClick && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-8 w-8 transition-opacity", isHovered || hasReactions ? "opacity-100" : "opacity-0")}
                          onClick={() => onReactionClick(message.id)}
                          title="View reactions"
                        >
                          <Heart className={cn("h-4 w-4", hasReactions && "fill-red-500 text-red-500")} />
                        </Button>
                      )}
                    </div>

                    {/* Message content */}
                    <div className="max-w-[80%] rounded-lg p-3 shadow-sm bg-chat-received text-chat-received-foreground">
                      {/* Poll message */}
                      {message.mediaType === 'poll' && message.pollData ? (
                        <PollMessage pollData={message.pollData} />
                      ) : (
                        /* Regular message */
                        <div>
                          {renderMediaIcon(message.mediaType)}
                          <p className="text-sm break-words whitespace-pre-wrap">{message.content}</p>
                        </div>
                      )}

                      {/* Timestamp and forwarding score */}
                      <div className="flex items-center justify-between mt-2 text-xs opacity-60">
                        <p>{formatTimestamp(message.timestamp)}</p>
                        {message.forwardingScore > 0 && (
                          <p className="text-xs italic">Forwarded {message.forwardingScore}x</p>
                        )}
                      </div>

                      {/* Reactions summary */}
                      {hasReactions && (
                        <div className="mt-2 pt-2 border-t border-current/20">
                          <div className="flex flex-wrap gap-1">
                            {message.reactions?.slice(0, 5).map((reaction: any, idx: number) => (
                              <span key={idx} className="text-xs bg-white/10 px-2 py-0.5 rounded-full">
                                {reaction}
                              </span>
                            ))}
                            {message.reactions && message.reactions.length > 5 && (
                              <span className="text-xs opacity-60">+{message.reactions.length - 5}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
