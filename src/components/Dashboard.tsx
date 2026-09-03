import React, { useState } from 'react';
import { AnalyticsStats, Conversation } from '../types';
import { 
  MessageSquare, 
  Hash, 
  BarChart3, 
  FileText, 
  Sparkles, 
  Clock, 
  Calendar, 
  Brain,
  Zap,
  Flame,
  HelpCircle,
  Code
} from 'lucide-react';

interface DashboardProps {
  stats: AnalyticsStats;
  conversations: Conversation[];
  onSelectConversation: (id: string) => void;
}

export default function Dashboard({ stats, conversations, onSelectConversation }: DashboardProps) {
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);
  const [hoveredHour, setHoveredHour] = useState<string | null>(null);

  // Find the max value in monthly activity to scale the SVG chart
  const maxMonthlyCount = Math.max(...stats.monthlyActivity.map(m => m.count), 1);
  const maxHourlyCount = Math.max(...stats.hourlyActivity.map(h => h.count), 1);
  const maxWeekdayCount = Math.max(...stats.weekdayActivity.map(w => w.count), 1);

  // Calculate some fun insights
  const funInsight = () => {
    if (conversations.length === 0) return null;
    
    // Find most active model
    const topModel = stats.modelDistribution[0]?.name || 'Grok 2';
    
    // Count reasoning sessions
    const reasoningChats = conversations.filter(c => c.mode === 'Think').length;
    
    // Count fun roasts
    const funChats = conversations.filter(c => c.mode === 'Fun').length;

    // Peak hour
    let peakHour = "12:00";
    let maxHourCount = -1;
    stats.hourlyActivity.forEach(h => {
      if (h.count > maxHourCount) {
        maxHourCount = h.count;
        peakHour = h.label;
      }
    });

    return {
      topModel,
      reasoningChats,
      funChats,
      peakHour,
    };
  };

  const insights = funInsight();

  // Sort latest chats for "Recent Activity" list
  const recentChats = [...conversations]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-8 animate-fade-in" id="dashboard-container">
      {/* 4-Column Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="stats-grid">
        {/* Card 1 */}
        <div className="bg-elegant-panel border border-elegant-border hover:border-elegant-gold/20 rounded-xl p-5 flex items-center space-x-4 shadow-md transition-all duration-300" id="stat-card-chats">
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/20 text-elegant-gold rounded-lg shadow-inner">
            <MessageSquare className="w-5.5 h-5.5" />
          </div>
          <div>
            <p className="text-xxs font-mono text-elegant-muted uppercase tracking-wider">Conversations</p>
            <h3 className="text-2xl font-display font-semibold text-white mt-1.5">{stats.totalConversations}</h3>
          </div>
        </div>

        {/* Card 2 */}
        <div className="bg-elegant-panel border border-elegant-border hover:border-elegant-gold/20 rounded-xl p-5 flex items-center space-x-4 shadow-md transition-all duration-300" id="stat-card-messages">
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/20 text-elegant-gold rounded-lg shadow-inner">
            <Hash className="w-5.5 h-5.5" />
          </div>
          <div>
            <p className="text-xxs font-mono text-elegant-muted uppercase tracking-wider">Total Messages</p>
            <h3 className="text-2xl font-display font-semibold text-white mt-1.5">{stats.totalMessages}</h3>
          </div>
        </div>

        {/* Card 3 */}
        <div className="bg-elegant-panel border border-elegant-border hover:border-elegant-gold/20 rounded-xl p-5 flex items-center space-x-4 shadow-md transition-all duration-300" id="stat-card-avg">
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/20 text-elegant-gold rounded-lg shadow-inner">
            <BarChart3 className="w-5.5 h-5.5" />
          </div>
          <div>
            <p className="text-xxs font-mono text-elegant-muted uppercase tracking-wider">Avg. Messages / Chat</p>
            <h3 className="text-2xl font-display font-semibold text-white mt-1.5">{stats.avgMessagesPerChat}</h3>
          </div>
        </div>

        {/* Card 4 */}
        <div className="bg-elegant-panel border border-elegant-border hover:border-elegant-gold/20 rounded-xl p-5 flex items-center space-x-4 shadow-md transition-all duration-300" id="stat-card-chars">
          <div className="p-3.5 bg-elegant-gold/10 border border-elegant-gold/20 text-elegant-gold rounded-lg shadow-inner">
            <FileText className="w-5.5 h-5.5" />
          </div>
          <div>
            <p className="text-xxs font-mono text-elegant-muted uppercase tracking-wider">Characters Indexed</p>
            <h3 className="text-2xl font-display font-semibold text-white mt-1.5">
              {stats.totalCharacters > 100000 
                ? `${(stats.totalCharacters / 1000).toFixed(0)}k` 
                : stats.totalCharacters.toLocaleString()}
            </h3>
          </div>
        </div>
      </div>

      {/* Main Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="bento-grid">
        {/* Chart 1: Monthly Trend (SVG Area Chart) */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-8 shadow-md flex flex-col justify-between" id="chart-monthly-trend">
          <div>
            <div className="flex justify-between items-center mb-4">
              <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center">
                <Calendar className="w-4 h-4 mr-2 text-elegant-gold" />
                Monthly Chat Activity
              </h4>
              <span className="text-xxs font-mono text-elegant-gold bg-elegant-dark/80 border border-elegant-border px-2.5 py-1 rounded uppercase tracking-wider">2026 Archive</span>
            </div>
            
            {/* SVG Plot */}
            <div className="relative h-56 w-full mt-4 flex items-end">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 500 200" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c5a880" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#c5a880" stopOpacity="0.0" />
                  </linearGradient>
                </defs>
                
                {/* Horizontal Gridlines */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => (
                  <line 
                    key={idx}
                    x1="0" 
                    y1={200 - ratio * 180} 
                    x2="500" 
                    y2={200 - ratio * 180} 
                    stroke="#1f1f1f" 
                    strokeWidth="1" 
                    strokeDasharray="4 4" 
                  />
                ))}

                {/* Draw Area */}
                {(() => {
                  const points = stats.monthlyActivity.map((m, idx) => {
                    const x = (idx / (stats.monthlyActivity.length - 1)) * 500;
                    const y = 200 - (m.count / maxMonthlyCount) * 160;
                    return { x, y };
                  });

                  if (points.length === 0) return null;

                  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                  const areaPath = `${linePath} L ${points[points.length - 1].x} 200 L ${points[0].x} 200 Z`;

                  return (
                    <>
                      <path d={areaPath} fill="url(#areaGrad)" />
                      <path d={linePath} fill="none" stroke="#c5a880" strokeWidth="2" />
                      
                      {/* Dots on top */}
                      {points.map((p, idx) => (
                        <g key={idx}>
                          <circle 
                            cx={p.x} 
                            cy={p.y} 
                            r="4" 
                            fill="#c5a880" 
                            stroke="#080808" 
                            strokeWidth="1.5" 
                            className="cursor-pointer transition-all duration-150 hover:r-6"
                            onMouseEnter={() => setHoveredMonth(`${stats.monthlyActivity[idx].label}: ${stats.monthlyActivity[idx].count} chats`)}
                            onMouseLeave={() => setHoveredMonth(null)}
                          />
                        </g>
                      ))}
                    </>
                  );
                })()}
              </svg>

              {/* Tooltip Overlay */}
              {hoveredMonth && (
                <div className="absolute top-2 right-2 bg-elegant-card border border-elegant-gold/30 px-2.5 py-1.5 rounded text-xs text-elegant-gold font-mono shadow-lg animate-fade-in">
                  {hoveredMonth}
                </div>
              )}
            </div>
          </div>
          
          {/* X Axis Labels */}
          <div className="flex justify-between px-1 mt-3 border-t border-elegant-border pt-2 text-xxs text-elegant-muted font-mono uppercase">
            {stats.monthlyActivity.map((m, idx) => (
              <span key={idx} className="w-8 text-center">{m.label}</span>
            ))}
          </div>
        </div>

        {/* Chart 2: Model Distribution (Bar list) */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-4 shadow-md flex flex-col justify-between" id="chart-models">
          <div>
            <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center mb-5">
              <Zap className="w-4 h-4 mr-2 text-elegant-gold" />
              Model Distribution
            </h4>

            {stats.modelDistribution.length === 0 ? (
              <div className="text-center py-8 text-elegant-muted text-xs">No model data found</div>
            ) : (
              <div className="space-y-4">
                {stats.modelDistribution.map((m, idx) => {
                  const maxCount = Math.max(...stats.modelDistribution.map(item => item.count), 1);
                  const percentage = Math.round((m.count / stats.totalConversations) * 100) || 0;
                  const scalePct = (m.count / maxCount) * 100;

                  // Let's elegantly style the model dots to match our gold scale or its original distinct value in an elegant shade
                  return (
                    <div key={idx} className="space-y-1.5">
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-medium text-elegant-text flex items-center font-sans">
                          <span className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: m.color }} />
                          {m.name}
                        </span>
                        <span className="font-mono text-elegant-gold text-xxs">
                          {m.count} ({percentage}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-elegant-dark/80 border border-elegant-border rounded-full overflow-hidden">
                        <div 
                          className="h-full rounded-full transition-all duration-500"
                          style={{ 
                            width: `${scalePct}%`, 
                            backgroundColor: m.color 
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-elegant-border pt-3 mt-4 text-xxs text-elegant-muted flex justify-between items-center">
            <span>Primary model:</span>
            <span className="font-medium text-elegant-gold font-mono tracking-wider">
              {stats.modelDistribution[0]?.name || 'None'}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Heatmap / Hourly distribution */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-6 shadow-md" id="chart-hourly">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center">
              <Clock className="w-4 h-4 mr-2 text-elegant-gold" />
              Time of Day Pattern
            </h4>
            {hoveredHour && (
              <span className="text-xxs font-mono text-elegant-gold uppercase tracking-wider">{hoveredHour}</span>
            )}
          </div>

          {/* SVG Hourly columns */}
          <div className="h-44 w-full flex items-end justify-between relative mt-6">
            {stats.hourlyActivity.map((h, idx) => {
              const hRatio = maxHourlyCount > 0 ? h.count / maxHourlyCount : 0;
              const barHeight = Math.max(hRatio * 100, 3); // minimum 3% height so it's always interactable
              
              // Only label every 4 hours to avoid clutter
              const hourNum = parseInt(h.label.split(':')[0]);
              const shouldLabel = hourNum % 4 === 0;

              return (
                <div 
                  key={idx} 
                  className="flex flex-col items-center group flex-1 mx-0.5"
                  onMouseEnter={() => setHoveredHour(`Hour ${h.label}: ${h.count} chats`)}
                  onMouseLeave={() => setHoveredHour(null)}
                >
                  <div className="w-full relative h-32 flex items-end">
                    <div 
                      className="w-full bg-gradient-to-t from-elegant-gold-dark/40 to-elegant-gold rounded-t-xs cursor-pointer group-hover:from-elegant-gold/60 group-hover:to-elegant-gold-light transition-all duration-150 border border-elegant-gold/20"
                      style={{ height: `${barHeight}%` }}
                    />
                  </div>
                  <span className="text-xxxs text-elegant-muted font-mono mt-2 select-none h-4">
                    {shouldLabel ? `${hourNum}h` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Weekly activity (horizontal bar chart) */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-6 shadow-md flex flex-col justify-between" id="chart-weekdays">
          <div>
            <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center mb-5">
              <Calendar className="w-4 h-4 mr-2 text-elegant-gold" />
              Activity by Day of Week
            </h4>

            <div className="space-y-3">
              {stats.weekdayActivity.map((w, idx) => {
                const ratio = maxWeekdayCount > 0 ? w.count / maxWeekdayCount : 0;
                
                return (
                  <div key={idx} className="flex items-center text-xs">
                    <span className="w-20 text-elegant-text font-medium font-mono uppercase text-xxs">{w.label}</span>
                    <div className="flex-1 h-2.5 bg-elegant-dark/80 border border-elegant-border rounded-full overflow-hidden mx-3 relative">
                      <div 
                        className="h-full bg-gradient-to-r from-elegant-gold-dark to-elegant-gold rounded-full transition-all duration-500"
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right font-mono text-elegant-gold text-xxs font-semibold">{w.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Keywords and Interests cloud */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-6 shadow-md" id="interests-panel">
          <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center mb-4">
            <Sparkles className="w-4 h-4 mr-2 text-elegant-gold" />
            Top User Interests & Keywords
          </h4>
          <p className="text-xs text-elegant-muted mb-5">
            Key terminology extracted from your prompts. Categorized automatically.
          </p>

          {stats.topKeywords.length === 0 ? (
            <div className="text-center py-12 text-elegant-muted text-xs">
              Upload chat logs to extract keyword stats.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2" id="keyword-cloud">
              {stats.topKeywords.map((k, idx) => {
                let badgeClass = "bg-elegant-dark/60 border-elegant-border text-elegant-text hover:border-elegant-gold/40";
                let catName = "General";
                
                if (k.category === 'tech') {
                  badgeClass = "bg-elegant-dark border border-elegant-border text-elegant-gold hover:border-elegant-gold-light hover:bg-elegant-hover/50";
                  catName = "Technical";
                } else if (k.category === 'creative') {
                  badgeClass = "bg-elegant-dark border border-elegant-border text-elegant-gold-light/90 hover:border-elegant-gold hover:bg-elegant-hover/50";
                  catName = "Creative / Fun";
                } else if (k.category === 'query') {
                  badgeClass = "bg-elegant-dark border border-elegant-border text-white/90 hover:border-elegant-gold/40 hover:bg-elegant-hover/50";
                  catName = "Query / Explanation";
                }

                return (
                  <div 
                    key={idx}
                    className={`px-3 py-1.5 rounded-md border text-xxs font-mono uppercase tracking-wider flex items-center space-x-2 transition-all duration-150 shadow-sm cursor-help ${badgeClass}`}
                    title={`Topic: ${k.word}. Category: ${catName}. Frequency: ${k.count} times`}
                  >
                    <span className="font-semibold">{k.word}</span>
                    <span className="text-xxs font-mono bg-elegant-dark/90 border border-elegant-border px-1.5 py-0.25 rounded text-elegant-gold font-bold">
                      {k.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fun AI Insights */}
        <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 lg:col-span-6 shadow-md flex flex-col justify-between" id="ai-insights-panel">
          <div>
            <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase flex items-center mb-4">
              <Brain className="w-4 h-4 mr-2 text-elegant-gold" />
              Usage Patterns & Insights
            </h4>
            
            {insights ? (
              <div className="space-y-4 text-xs text-elegant-text">
                <div className="bg-elegant-dark/40 border border-elegant-border rounded-lg p-3.5 flex items-start space-x-3.5">
                  <div className="p-2 bg-elegant-gold/10 text-elegant-gold rounded border border-elegant-gold/20 mt-0.5">
                    <Brain className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h5 className="font-display font-semibold text-white tracking-wide uppercase text-xxs mb-0.5">Reasoning Specialist</h5>
                    <p className="text-elegant-muted leading-relaxed">
                      You used <span className="text-elegant-gold font-semibold font-mono">Think Mode</span> ({insights.reasoningChats} times). You tend to ask Grok deep, logical, or scientific questions requiring a step-by-step thinking breakdown.
                    </p>
                  </div>
                </div>

                <div className="bg-elegant-dark/40 border border-elegant-border rounded-lg p-3.5 flex items-start space-x-3.5">
                  <div className="p-2 bg-elegant-gold/10 text-elegant-gold rounded border border-elegant-gold/20 mt-0.5">
                    <Flame className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h5 className="font-display font-semibold text-white tracking-wide uppercase text-xxs mb-0.5">Witty Banter & Humor</h5>
                    <p className="text-elegant-muted leading-relaxed">
                      You engaged in <span className="text-elegant-gold font-semibold font-mono">Fun Mode</span> ({insights.funChats} times). This shows you enjoy Grok's satirical roasts, witty commentary, and sarcastic conversational style.
                    </p>
                  </div>
                </div>

                <div className="bg-elegant-dark/40 border border-elegant-border rounded-lg p-3.5 flex items-start space-x-3.5">
                  <div className="p-2 bg-elegant-gold/10 text-elegant-gold rounded border border-elegant-gold/20 mt-0.5">
                    <Clock className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h5 className="font-display font-semibold text-white tracking-wide uppercase text-xxs mb-0.5">Productivity Hours</h5>
                    <p className="text-elegant-muted leading-relaxed">
                      Your peak interaction hour is <span className="text-elegant-gold font-semibold font-mono">{insights.peakHour}</span>. This is when your query volume and system logs indicate you are most active.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-elegant-muted">
                Upload custom logs to generate specialized usage reports.
              </div>
            )}
          </div>

          <div className="border-t border-elegant-border pt-3 mt-4 flex items-center justify-between text-xxs text-elegant-muted">
            <span className="font-mono tracking-wider uppercase">Archive Indexer v1.0</span>
            <span className="text-elegant-gold flex items-center uppercase font-mono tracking-widest text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full bg-elegant-gold animate-pulse mr-2" />
              Engine Online
            </span>
          </div>
        </div>
      </div>

      {/* Recent Chats Section */}
      <div className="bg-elegant-panel border border-elegant-border rounded-xl p-6 shadow-md" id="recent-chats-panel">
        <h4 className="text-sm font-display font-semibold tracking-wide text-white uppercase mb-4 flex items-center">
          <MessageSquare className="w-4 h-4 mr-2 text-elegant-gold" />
          Recent Conversations
        </h4>
        <div className="divide-y divide-elegant-border border border-elegant-border rounded-lg overflow-hidden" id="recent-chats-list">
          {recentChats.map((conv) => (
            <div 
              key={conv.id}
              className="p-4 flex items-center justify-between hover:bg-elegant-hover/30 transition-all cursor-pointer group"
              onClick={() => onSelectConversation(conv.id)}
            >
              <div className="flex items-center space-x-3.5 min-w-0">
                {conv.mode === 'Think' && (
                  <span className="p-2 bg-elegant-dark border border-elegant-gold/20 text-elegant-gold rounded-md shadow-sm">
                    <Brain className="w-4 h-4" />
                  </span>
                )}
                {conv.mode === 'Fun' && (
                  <span className="p-2 bg-elegant-dark border border-elegant-gold/20 text-elegant-gold-light rounded-md shadow-sm">
                    <Flame className="w-4 h-4" />
                  </span>
                )}
                {conv.mode === 'DeepSearch' && (
                  <span className="p-2 bg-elegant-dark border border-elegant-gold/20 text-elegant-gold rounded-md shadow-sm">
                    <Sparkles className="w-4 h-4" />
                  </span>
                )}
                {conv.mode === 'Normal' && (
                  <span className="p-2 bg-elegant-dark border border-elegant-border text-elegant-muted rounded-md shadow-sm">
                    <MessageSquare className="w-4 h-4" />
                  </span>
                )}
                <div className="min-w-0">
                  <h5 className="text-xs font-semibold text-elegant-text group-hover:text-white truncate">
                    {conv.title}
                  </h5>
                  <p className="text-xxs text-elegant-muted font-mono mt-0.5 uppercase tracking-wide">
                    {conv.model} • {conv.stats.messageCount} messages
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-4">
                <span className="text-xxs text-elegant-muted font-mono uppercase tracking-wider">
                  {new Date(conv.createdAt).toLocaleDateString(undefined, { 
                    month: 'short', 
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </span>
                <span className="text-xs text-elegant-gold group-hover:translate-x-1 transition-transform font-bold font-mono uppercase tracking-wider text-xxs">
                  Open →
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
