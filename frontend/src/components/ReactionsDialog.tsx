import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Loader2 } from 'lucide-react';
import { api, Reaction } from '../lib/api';
import { toast } from 'sonner';

interface ReactionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
}

export function ReactionsDialog({ open, onOpenChange, messageId }: ReactionsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [totalReactions, setTotalReactions] = useState(0);

  useEffect(() => {
    if (open && messageId) {
      fetchReactions();
    }
  }, [open, messageId]);

  const fetchReactions = async () => {
    if (!messageId) return;

    setLoading(true);
    try {
      const response = await api.getMessageReactions(messageId);

      if (response.success) {
        setReactions(response.reactions || []);
        setTotalReactions(response.totalReactions || 0);
      } else {
        toast.error(response.error || 'Failed to load reactions');
      }
    } catch (error) {
      console.error('Error fetching reactions:', error);
      toast.error('Failed to load reactions');
    } finally {
      setLoading(false);
    }
  };

  const renderReactorsList = (reactors: Array<{name: string; phone: string; timestamp: number}>, maxShow = 10) => {
    const showReactors = reactors.slice(0, maxShow);
    const remainingCount = reactors.length - maxShow;

    return (
      <div className="space-y-1">
        {showReactors.map((reactor, index) => (
          <div key={index} className="text-sm text-gray-700 dark:text-gray-300 pl-4">
            • {reactor.name} ({reactor.phone})
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400 pl-4 italic">
            ... and {remainingCount} more
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-2xl">❤️</span>
            Reactions
          </DialogTitle>
          <DialogDescription>
            {totalReactions} {totalReactions === 1 ? 'person' : 'people'} reacted to this message
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : reactions.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No reactions yet
            </div>
          ) : (
            <div className="space-y-6">
              {reactions.map((reaction, index) => (
                <div key={index} className="border-b pb-4 last:border-b-0">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">{reaction.emoji}</span>
                    <span className="text-lg font-semibold text-gray-800 dark:text-gray-200">
                      {reaction.count} {reaction.count === 1 ? 'reaction' : 'reactions'}
                    </span>
                  </div>
                  {renderReactorsList(reaction.reactors)}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
