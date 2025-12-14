import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Languages, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageInput } from "./MessageInput";

interface Message {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
  replied_to_message_id?: string | null;
  replied_to_sender?: string | null;
  replied_to_message?: string | null;
}

interface ChatViewProps {
  messages: Message[];
  groupName: string;
  groupId: string;
  onMessageSent?: () => void;
}

export function ChatView({ messages, groupName, groupId, onMessageSent }: ChatViewProps) {
  const [translatedMessages, setTranslatedMessages] = useState<Map<string, string>>(new Map());
  const [translatingMessages, setTranslatingMessages] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Check if user is at bottom
  const checkIfAtBottom = () => {
    if (scrollViewportRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollViewportRef.current;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100; // 100px threshold
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
  }, []);

  const handleTranslateMessage = async (messageId: string, messageContent: string) => {
    // If already translated, toggle it off
    if (translatedMessages.has(messageId)) {
      setTranslatedMessages(prev => {
        const newMap = new Map(prev);
        newMap.delete(messageId);
        return newMap;
      });
      return;
    }

    // Mark as translating
    setTranslatingMessages(prev => new Set(prev).add(messageId));

    try {
      // Call backend translation API
      const response = await fetch('/api/translate-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageId: messageId,
          text: messageContent
        })
      });

      const data = await response.json();

      if (data.success) {
        // Store the translation
        setTranslatedMessages(prev => {
          const newMap = new Map(prev);
          newMap.set(messageId, data.translated);
          return newMap;
        });
      } else {
        console.error('Translation failed:', data.error);
      }
    } catch (error) {
      console.error('Translation error:', error);
    } finally {
      // Remove from translating set
      setTranslatingMessages(prev => {
        const newSet = new Set(prev);
        newSet.delete(messageId);
        return newSet;
      });
    }
  };

  return (
    <div className="h-full flex flex-col bg-chat-bg">
      <div className="p-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground">{groupName}</h2>
      </div>
      <div className="flex-1 overflow-hidden" style={{ flex: '1 1 0', minHeight: 0 }}>
        <div
          ref={scrollViewportRef}
          onScroll={checkIfAtBottom}
          className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200"
        >
          <div className="space-y-4">
            {messages.map((message) => {
              const translation = translatedMessages.get(message.id);
              const isTranslating = translatingMessages.has(message.id);
              const isHovered = hoveredMessageId === message.id;

              return (
                <div
                  key={message.id}
                  className="flex gap-2 items-start justify-start"
                  onMouseEnter={() => setHoveredMessageId(message.id)}
                  onMouseLeave={() => setHoveredMessageId(null)}
                >
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-8 w-8 transition-opacity", isHovered ? "opacity-100" : "opacity-0")}
                      onClick={() => setReplyingTo(message)}
                      title="Reply to this message"
                    >
                      <Reply className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-8 w-8 transition-opacity", isHovered ? "opacity-100" : "opacity-0")}
                      onClick={() => handleTranslateMessage(message.id, message.content)}
                      disabled={isTranslating}
                      title="Translate message"
                    >
                      <Languages className={cn("h-4 w-4", isTranslating && "animate-pulse")} />
                    </Button>
                  </div>
                  <div className="max-w-[70%] rounded-lg p-3 shadow-sm bg-chat-received text-chat-received-foreground">
                    {/* Show replied-to message if exists */}
                    {message.replied_to_message_id && message.replied_to_sender && (
                      <div className="mb-2 pb-2 border-b border-current/20">
                        <div className="flex items-center gap-1 text-xs opacity-70 mb-1">
                          <Reply className="h-3 w-3" />
                          <span className="font-semibold">{message.replied_to_sender}</span>
                        </div>
                        <p className="text-xs italic opacity-60 truncate">
                          {message.replied_to_message}
                        </p>
                      </div>
                    )}

                    <p className="text-xs font-semibold mb-1 opacity-70">{message.sender}</p>
                    <p className="text-sm break-words">
                      {message.content}
                      {isTranslating && (
                        <span className="block mt-2 pt-2 border-t border-current/20 italic opacity-90 text-xs">
                          ⏳ Translating...
                        </span>
                      )}
                      {translation && (
                        <span className="block mt-2 pt-2 border-t border-current/20 italic opacity-90">
                          🇨🇳 {translation}
                        </span>
                      )}
                    </p>
                    <p className="text-xs mt-1 opacity-60">{message.timestamp}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <MessageInput
        groupId={groupId}
        onMessageSent={onMessageSent}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </div>
  );
}
