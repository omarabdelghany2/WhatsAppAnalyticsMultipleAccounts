import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Video, FileText } from "lucide-react";
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

export function ChannelView({ messages, channelName, channelId }: ChannelViewProps) {
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

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
                return (
                  <div
                    key={message.id}
                    className="flex gap-2 items-start justify-start"
                  >

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
