import { useState, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Languages } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
}

interface ChatViewProps {
  messages: Message[];
  groupName: string;
}

export function ChatView({ messages, groupName }: ChatViewProps) {
  const [translatedMessages, setTranslatedMessages] = useState<Set<string>>(new Set());
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

  const handleTranslateMessage = (messageId: string) => {
    setTranslatedMessages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
        // TODO: Call backend API to translate this message
        // await fetch('/api/translate', { method: 'POST', body: JSON.stringify({ messageId }) });
      }
      return newSet;
    });
  };

  return (
    <div className="h-full flex flex-col bg-chat-bg">
      <div className="p-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground">{groupName}</h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <div
          ref={scrollViewportRef}
          onScroll={checkIfAtBottom}
          className="h-full overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-gray-200"
          style={{ maxHeight: 'calc(100vh - 120px)' }}
        >
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className="flex gap-2 items-start justify-start"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 hover:opacity-100 transition-opacity"
                  onClick={() => handleTranslateMessage(message.id)}
                >
                  <Languages className="h-4 w-4" />
                </Button>
                <div className="max-w-[70%] rounded-lg p-3 shadow-sm bg-chat-received text-chat-received-foreground">
                  <p className="text-xs font-semibold mb-1 opacity-70">{message.sender}</p>
                  <p className="text-sm break-words">
                    {message.content}
                    {translatedMessages.has(message.id) && (
                      <span className="block mt-2 pt-2 border-t border-current/20 italic opacity-90">
                        {/* TODO: Show translated text from API response */}
                        [Individual translation will appear here]
                      </span>
                    )}
                  </p>
                  <p className="text-xs mt-1 opacity-60">{message.timestamp}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
