import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface PollVote {
  selectedOptions: number[];
  timestamp: number;
}

interface PollOption {
  name: string;
  localId: number;
}

interface PollData {
  pollName: string;
  pollOptions: PollOption[];
  votes: PollVote[];
}

interface PollMessageProps {
  pollData: PollData;
}

export function PollMessage({ pollData }: PollMessageProps) {
  const [expandedOptions, setExpandedOptions] = useState<Set<number>>(new Set());

  if (!pollData || !pollData.pollOptions) {
    return <div className="text-sm text-gray-500">[Poll]</div>;
  }

  // Calculate votes per option
  const optionVotes = new Map<number, PollVote[]>();
  pollData.pollOptions.forEach(option => {
    optionVotes.set(option.localId, []);
  });

  pollData.votes?.forEach(vote => {
    vote.selectedOptions?.forEach(optionId => {
      const votes = optionVotes.get(optionId) || [];
      votes.push(vote);
      optionVotes.set(optionId, votes);
    });
  });

  const totalVotes = pollData.votes?.length || 0;

  const toggleExpand = (optionId: number) => {
    const newExpanded = new Set(expandedOptions);
    if (newExpanded.has(optionId)) {
      newExpanded.delete(optionId);
    } else {
      newExpanded.add(optionId);
    }
    setExpandedOptions(newExpanded);
  };

  return (
    <div className="bg-white/10 rounded-lg p-3 max-w-md">
      {/* Poll question */}
      <div className="font-semibold text-base mb-3 flex items-center gap-2">
        <span className="text-lg">📊</span>
        {pollData.pollName}
      </div>

      {/* Poll options */}
      <div className="space-y-2">
        {pollData.pollOptions.map((option) => {
          const votes = optionVotes.get(option.localId) || [];
          const voteCount = votes.length;
          const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
          const isExpanded = expandedOptions.has(option.localId);

          return (
            <div key={option.localId} className="space-y-1">
              {/* Option bar */}
              <div
                className="relative bg-white/5 rounded-md overflow-hidden cursor-pointer hover:bg-white/10 transition-colors"
                onClick={() => voteCount > 0 && toggleExpand(option.localId)}
              >
                {/* Progress bar */}
                <div
                  className="absolute inset-y-0 left-0 bg-primary/30 transition-all duration-300"
                  style={{ width: `${percentage}%` }}
                />

                {/* Option content */}
                <div className="relative px-3 py-2 flex items-center justify-between">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{option.name}</div>
                  </div>
                  <div className="flex items-center gap-2 ml-2">
                    <div className="text-sm font-semibold whitespace-nowrap">
                      {percentage}% ({voteCount})
                    </div>
                    {voteCount > 0 && (
                      <div className="w-4">
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Voters list (expanded) */}
              {isExpanded && voteCount > 0 && (
                <div className="ml-3 pl-3 border-l-2 border-primary/30 space-y-1">
                  {votes.slice(0, 10).map((vote, idx) => (
                    <div key={idx} className="text-xs text-gray-300 py-0.5">
                      • Voter {idx + 1}
                    </div>
                  ))}
                  {votes.length > 10 && (
                    <div className="text-xs text-gray-400 italic py-0.5">
                      ... and {votes.length - 10} more
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Total votes footer */}
      <div className="mt-3 pt-2 border-t border-white/10 text-xs text-gray-400">
        {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
      </div>
    </div>
  );
}
