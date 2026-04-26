import React, { useState, useMemo } from 'react';
import clsx from 'clsx';
import {
  Search,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Clock,
  Hash,
  BarChart3,
  Filter,
  GitBranch,
} from 'lucide-react';
import { formatDuration, formatNumber, generateColor } from '../../utils/format';

interface Variant {
  id: string;
  activities: string[];
  frequency: number;
  percentage: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
}

interface VariantExplorerProps {
  variants: Variant[];
  totalCases: number;
  totalVariants: number;
  onVariantSelect?: (variant: Variant) => void;
}

type SortKey = 'frequency' | 'duration' | 'steps';

const VariantExplorer: React.FC<VariantExplorerProps> = ({
  variants,
  totalCases,
  totalVariants,
  onVariantSelect,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('frequency');
  const [showTopN, setShowTopN] = useState<number>(20);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  // Calculate average duration across all variants
  const avgDuration = useMemo(() => {
    if (variants.length === 0) return 0;
    const total = variants.reduce(
      (sum, v) => sum + v.avg_duration * v.frequency,
      0
    );
    const totalFreq = variants.reduce((sum, v) => sum + v.frequency, 0);
    return totalFreq > 0 ? total / totalFreq : 0;
  }, [variants]);

  // Max frequency for bar widths
  const maxFrequency = useMemo(
    () => Math.max(...variants.map((v) => v.frequency), 1),
    [variants]
  );

  // Filtered and sorted variants
  const processedVariants = useMemo(() => {
    let filtered = [...variants];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((v) =>
        v.activities.some((a) => a.toLowerCase().includes(query))
      );
    }

    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'frequency':
          return b.frequency - a.frequency;
        case 'duration':
          return b.avg_duration - a.avg_duration;
        case 'steps':
          return b.activities.length - a.activities.length;
        default:
          return 0;
      }
    });

    return filtered.slice(0, showTopN);
  }, [variants, searchQuery, sortBy, showTopN]);

  // Coverage bar data (top 10)
  const coverageData = useMemo(() => {
    const top = variants
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 8);
    const topTotal = top.reduce((sum, v) => sum + v.percentage, 0);
    const otherPercentage = Math.max(0, 1 - topTotal);
    return { top, otherPercentage };
  }, [variants]);

  const handleSelect = (variant: Variant) => {
    setSelectedId(variant.id === selectedId ? null : variant.id);
    onVariantSelect?.(variant);
  };

  const getDurationColor = (duration: number): string => {
    if (avgDuration === 0) return 'text-fg-muted';
    const ratio = duration / avgDuration;
    if (ratio <= 0.7) return 'text-success';
    if (ratio <= 1.3) return 'text-warning';
    return 'text-danger';
  };

  return (
    <div className="bg-surface-2 rounded-xl border border-line overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-line">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
              <GitBranch className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-fg">
                Variant Explorer
              </h2>
              <p className="text-[12px] text-fg-muted">
                {formatNumber(totalVariants)} variants across{' '}
                {formatNumber(totalCases)} cases
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <p className="text-[12px] text-fg-faint">Avg Duration</p>
              <p className="text-sm font-semibold text-fg-secondary">
                {formatDuration(avgDuration)}
              </p>
            </div>
          </div>
        </div>

        {/* Coverage bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[12px] font-medium text-fg-muted">
              Variant Coverage
            </span>
            <span className="text-[12px] text-fg-faint">
              Top {coverageData.top.length} variants
            </span>
          </div>
          <div className="flex h-3 rounded-full overflow-hidden bg-tint">
            {coverageData.top.map((v, i) => (
              <div
                key={v.id}
                className="h-full transition-all duration-300 hover:opacity-80 cursor-pointer relative group"
                style={{
                  width: `${v.percentage * 100}%`,
                  backgroundColor: generateColor(i),
                  minWidth: v.percentage > 0.01 ? '2px' : '0',
                }}
                title={`Variant #${i + 1}: ${(v.percentage * 100).toFixed(1)}%`}
              >
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-surface-1 border border-line text-fg-secondary text-[10px] rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                  #{i + 1}: {(v.percentage * 100).toFixed(1)}%
                </div>
              </div>
            ))}
            {coverageData.otherPercentage > 0 && (
              <div
                className="h-full bg-tint"
                style={{ width: `${coverageData.otherPercentage * 100}%` }}
                title={`Other: ${(coverageData.otherPercentage * 100).toFixed(1)}%`}
              />
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="px-5 py-3 border-b border-line bg-surface-1/50 flex items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-faint" />
          <input
            type="text"
            placeholder="Search activities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input w-full pl-9"
          />
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1.5 bg-surface-2 border border-line rounded-lg p-0.5">
          {[
            { key: 'frequency' as SortKey, label: 'Frequency', icon: BarChart3 },
            { key: 'duration' as SortKey, label: 'Duration', icon: Clock },
            { key: 'steps' as SortKey, label: 'Steps', icon: Hash },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all',
                sortBy === key
                  ? 'bg-tint text-accent'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Show top N */}
        <div className="relative">
          <button
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-line rounded-lg text-xs font-medium text-fg-muted hover:border-line-strong transition-colors"
          >
            <Filter className="w-3.5 h-3.5" />
            Top {showTopN}
            <ChevronDown className="w-3 h-3" />
          </button>
          {isFilterOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setIsFilterOpen(false)}
              />
              <div className="absolute right-0 top-full mt-1 bg-surface-1 border border-line rounded-lg py-1 z-20 min-w-[100px]">
                {[10, 20, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setShowTopN(n);
                      setIsFilterOpen(false);
                    }}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-xs hover:bg-tint transition-colors',
                      showTopN === n
                        ? 'text-accent font-medium'
                        : 'text-fg-muted'
                    )}
                  >
                    Top {n}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setShowTopN(Infinity);
                    setIsFilterOpen(false);
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-1.5 text-xs hover:bg-tint transition-colors border-t border-line',
                    showTopN === Infinity
                      ? 'text-accent font-medium'
                      : 'text-fg-muted'
                  )}
                >
                  Show All
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Variant list */}
      <div className="max-h-[600px] overflow-y-auto">
        {processedVariants.length === 0 ? (
          <div className="text-center py-12">
            <Search className="w-8 h-8 text-fg-ghost mx-auto mb-3" />
            <p className="text-sm text-fg-muted">No matching variants found</p>
            <p className="text-[12px] text-fg-faint mt-1">
              Try a different search term
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {processedVariants.map((variant, index) => {
              const rank = index + 1;
              const isSelected = variant.id === selectedId;

              return (
                <button
                  key={variant.id}
                  onClick={() => handleSelect(variant)}
                  className={clsx(
                    'w-full text-left px-5 py-3.5 transition-colors hover:bg-tint/30',
                    isSelected && 'bg-accent/5 hover:bg-accent/10'
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Rank */}
                    <div
                      className={clsx(
                        'flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold',
                        rank <= 3
                          ? 'bg-accent/10 text-accent'
                          : 'bg-tint text-fg-muted'
                      )}
                    >
                      #{rank}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Activity sequence */}
                      <div className="flex items-center flex-wrap gap-1 mb-2">
                        {variant.activities.map((act, i) => (
                          <React.Fragment key={i}>
                            <span
                              className={clsx(
                                'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium',
                                i === 0
                                  ? 'bg-success/10 text-success border border-line'
                                  : i === variant.activities.length - 1
                                  ? 'bg-danger/10 text-danger border border-line'
                                  : 'bg-tint text-fg-muted border border-line-strong'
                              )}
                            >
                              {act}
                            </span>
                            {i < variant.activities.length - 1 && (
                              <ArrowRight className="w-3 h-3 text-fg-ghost flex-shrink-0" />
                            )}
                          </React.Fragment>
                        ))}
                      </div>

                      {/* Stats row */}
                      <div className="flex items-center gap-4">
                        {/* Frequency bar */}
                        <div className="flex-1 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-tint rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${(variant.frequency / maxFrequency) * 100}%`,
                                backgroundColor: generateColor(index),
                              }}
                            />
                          </div>
                          <span className="flex-shrink-0 text-xs font-semibold text-fg-secondary tabular-nums">
                            {formatNumber(variant.frequency)}
                          </span>
                          <span className="flex-shrink-0 text-[12px] text-fg-faint tabular-nums">
                            ({(variant.percentage * 100).toFixed(1)}%)
                          </span>
                        </div>

                        {/* Duration */}
                        <div
                          className={clsx(
                            'flex items-center gap-1 flex-shrink-0',
                            getDurationColor(variant.avg_duration)
                          )}
                        >
                          <Clock className="w-3 h-3" />
                          <span className="text-xs font-medium tabular-nums">
                            {formatDuration(variant.avg_duration)}
                          </span>
                        </div>

                        {/* Steps count */}
                        <span className="text-[12px] text-fg-faint flex-shrink-0 tabular-nums">
                          {variant.activities.length} steps
                        </span>
                      </div>

                      {/* Expanded details */}
                      {isSelected && (
                        <div className="mt-3 pt-3 border-t border-line grid grid-cols-3 gap-3">
                          <div>
                            <p className="text-[10px] text-fg-faint uppercase tracking-wider">
                              Min Duration
                            </p>
                            <p className="text-sm font-semibold text-fg-secondary">
                              {formatDuration(variant.min_duration)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-fg-faint uppercase tracking-wider">
                              Avg Duration
                            </p>
                            <p className="text-sm font-semibold text-fg-secondary">
                              {formatDuration(variant.avg_duration)}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-fg-faint uppercase tracking-wider">
                              Max Duration
                            </p>
                            <p className="text-sm font-semibold text-fg-secondary">
                              {formatDuration(variant.max_duration)}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Expand indicator */}
                    <div className="flex-shrink-0 mt-1">
                      {isSelected ? (
                        <ChevronUp className="w-4 h-4 text-fg-muted" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-fg-ghost" />
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      {processedVariants.length < variants.length && (
        <div className="px-5 py-3 border-t border-line bg-surface-1/50 text-center">
          <p className="text-[12px] text-fg-faint">
            Showing {processedVariants.length} of {variants.length} variants
          </p>
        </div>
      )}
    </div>
  );
};

export default VariantExplorer;
