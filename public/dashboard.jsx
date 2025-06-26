import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const Dashboard = () => {
  const [data, setData] = useState({
    latest: null,
    history: null,
    stats: null,
    loading: true
  });

  const fetchData = async () => {
    try {
      const [latestRes, historyRes, statsRes] = await Promise.all([
        fetch('/latest'),
        fetch('/history?limit=30'),
        fetch('/history-stats')
      ]);

      const latest = latestRes.ok ? await latestRes.json() : null;
      const history = historyRes.ok ? await historyRes.json() : null;
      const stats = statsRes.ok ? await statsRes.json() : null;

      setData({ latest, history, stats, loading: false });
    } catch (error) {
      console.error('Error fetching data:', error);
      setData(prev => ({ ...prev, loading: false }));
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2 * 60 * 1000); // 2 minutes
    return () => clearInterval(interval);
  }, []);

  const formatNumber = (num) => {
    if (num === null || num === undefined) return 'N/A';
    return new Intl.NumberFormat().format(Math.round(num));
  };

  const formatPercent = (num) => {
    if (num === null || num === undefined) return 'N/A';
    return `${num.toFixed(1)}%`;
  };

  const getStatusColor = (isOnTrack) => {
    if (isOnTrack === true) return 'text-green-400';
    if (isOnTrack === false) return 'text-red-400';
    return 'text-gray-400';
  };

  const getTrendEmoji = (trend) => {
    switch(trend) {
      case 'accelerating': return '🚀';
      case 'slowing': return '📉';
      case 'steady': return '➡️';
      default: return '❓';
    }
  };

  const { latest, history, stats, loading } = data;

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center">
        <div className="text-white text-2xl">🎮 Loading Dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 to-blue-600 text-white">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold mb-2 bg-gradient-to-r from-white to-purple-200 bg-clip-text text-transparent">
            🎮 Stop Killing Games
          </h1>
          <p className="text-xl opacity-90">European Citizens' Initiative Progress Tracker</p>
        </div>

        {/* Main Progress Section */}
        <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 mb-8 border border-white/20">
          <div className="flex flex-col lg:flex-row justify-between items-center mb-6">
            <div>
              <div className="text-4xl lg:text-6xl font-bold bg-gradient-to-r from-green-400 to-blue-400 bg-clip-text text-transparent">
                {formatNumber(latest?.signatures)}
              </div>
              <div className="text-lg opacity-80">
                of {formatNumber(latest?.goal)} signatures ({formatPercent(latest?.progress_percent)})
              </div>
            </div>
            <div className={`flex items-center gap-3 px-6 py-3 rounded-full border-2 ${
              latest?.on_track_daily ? 'bg-green-500/20 border-green-400 text-green-400' : 
              latest?.on_track_daily === false ? 'bg-red-500/20 border-red-400 text-red-400' : 
              'bg-gray-500/20 border-gray-400 text-gray-400'
            }`}>
              <span className="text-2xl">{getTrendEmoji(latest?.velocity_trend)}</span>
              <span className="font-bold text-lg">
                {latest?.on_track_daily ? 'ON TRACK' : 
                 latest?.on_track_daily === false ? 'BEHIND SCHEDULE' : 'MONITORING'}
              </span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-white/20 rounded-full h-8 mb-6 relative overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-green-400 to-blue-400 rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${Math.min(latest?.progress_percent || 0, 100)}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center font-bold text-white text-lg">
              {formatPercent(latest?.progress_percent || 0)}
            </div>
          </div>

          {/* Key Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-black/20 rounded-2xl p-6 text-center">
              <div className="text-3xl font-bold text-orange-400 mb-2">
                {formatNumber(latest?.goal - latest?.signatures)}
              </div>
              <div className="opacity-80">Signatures Remaining</div>
            </div>
            <div className="bg-black/20 rounded-2xl p-6 text-center">
              <div className="text-3xl font-bold text-blue-400 mb-2">
                {formatNumber(latest?.actual_per_day)}
              </div>
              <div className="opacity-80">Current Daily Rate</div>
            </div>
            <div className="bg-black/20 rounded-2xl p-6 text-center">
              <div className={`text-3xl font-bold mb-2 ${
                latest?.velocity_trend === 'accelerating' ? 'text-green-400' :
                latest?.velocity_trend === 'slowing' ? 'text-red-400' : 'text-gray-400'
              }`}>
                {latest?.velocity_trend || 'unknown'}
              </div>
              <div className="opacity-80">Momentum</div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 mb-8">
          {/* Deadline Info */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
              ⏰ Deadline Info
            </h3>
            <div className="text-center">
              <div className="text-4xl font-bold text-green-400 mb-2">
                {latest?.days_remaining || 'N/A'}
              </div>
              <div className="opacity-80 mb-4">Days Remaining</div>
              {latest?.deadline && (
                <div className="text-sm opacity-70">
                  Until {new Date(latest.deadline).toLocaleDateString('en-US', { 
                    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                  })}
                </div>
              )}
            </div>
            <div className="border-t border-white/20 mt-4 pt-4 grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-lg font-bold">{formatNumber(latest?.required_per_day)}</div>
                <div className="text-sm opacity-70">Target Daily</div>
              </div>
              <div>
                <div className="text-lg font-bold">{formatNumber(latest?.required_per_hour)}</div>
                <div className="text-sm opacity-70">Target Hourly</div>
              </div>
            </div>
          </div>

          {/* Real-Time Rates */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
              ⚡ Real-Time Rates
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="opacity-80">Per Minute</span>
                <span className="font-bold">{formatNumber(latest?.actual_per_minute)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">Per Hour</span>
                <span className="font-bold">{formatNumber(latest?.actual_per_hour)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">Per Day</span>
                <span className="font-bold">{formatNumber(latest?.actual_per_day)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">Per Week</span>
                <span className="font-bold">{formatNumber(latest?.actual_per_week)}</span>
              </div>
            </div>
          </div>

          {/* Performance Metrics */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
              📊 Performance Metrics
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="opacity-80">On Track (Daily)</span>
                <span className={`font-bold ${getStatusColor(latest?.on_track_daily)}`}>
                  {latest?.on_track_daily ? 'YES' : latest?.on_track_daily === false ? 'NO' : 'N/A'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">On Track (Hourly)</span>
                <span className={`font-bold ${getStatusColor(latest?.on_track_hourly)}`}>
                  {latest?.on_track_hourly ? 'YES' : latest?.on_track_hourly === false ? 'NO' : 'N/A'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">Data Points</span>
                <span className="font-bold">{stats?.total_entries || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="opacity-80">Total Growth</span>
                <span className="font-bold text-green-400">{formatNumber(stats?.total_growth)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Target vs Actual Comparison */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-8 border border-white/20">
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            🎯 Target vs Actual Performance
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h4 className="font-bold text-lg mb-4">Daily Performance</h4>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Target</span>
                  <span className="font-bold text-blue-400">{formatNumber(latest?.required_per_day)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Actual</span>
                  <span className={`font-bold ${getStatusColor(latest?.on_track_daily)}`}>
                    {formatNumber(latest?.actual_per_day)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Performance</span>
                  <span className={`font-bold ${
                    latest?.required_per_day && latest?.actual_per_day && 
                    (latest.actual_per_day / latest.required_per_day) >= 1 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {latest?.required_per_day && latest?.actual_per_day ? 
                      `${((latest.actual_per_day / latest.required_per_day) * 100).toFixed(0)}%` : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
            <div>
              <h4 className="font-bold text-lg mb-4">Hourly Performance</h4>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Target</span>
                  <span className="font-bold text-blue-400">{formatNumber(latest?.required_per_hour)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Actual</span>
                  <span className={`font-bold ${getStatusColor(latest?.on_track_hourly)}`}>
                    {formatNumber(latest?.actual_per_hour)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="opacity-80">Performance</span>
                  <span className={`font-bold ${
                    latest?.required_per_hour && latest?.actual_per_hour && 
                    (latest.actual_per_hour / latest.required_per_hour) >= 1 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {latest?.required_per_hour && latest?.actual_per_hour ? 
                      `${((latest.actual_per_hour / latest.required_per_hour) * 100).toFixed(0)}%` : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
          <h3 className="text-xl font-bold mb-6">📈 Signature Growth Trend</h3>
          <div className="h-80">
            {history?.data?.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history.data.reverse()}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis 
                    dataKey="timestamp" 
                    tickFormatter={(value) => new Date(value).toLocaleDateString()}
                    stroke="rgba(255,255,255,0.7)"
                  />
                  <YAxis 
                    tickFormatter={(value) => formatNumber(value)}
                    stroke="rgba(255,255,255,0.7)"
                  />
                  <Tooltip 
                    formatter={(value) => [formatNumber(value), 'Signatures']}
                    labelFormatter={(value) => new Date(value).toLocaleDateString()}
                    contentStyle={{ 
                      backgroundColor: 'rgba(0,0,0,0.8)', 
                      border: 'none', 
                      borderRadius: '8px',
                      color: 'white'
                    }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="signatures" 
                    stroke="#4ADE80" 
                    strokeWidth={3}
                    dot={{ fill: '#4ADE80', strokeWidth: 2, r: 4 }}
                    activeDot={{ r: 6, stroke: '#4ADE80', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                No chart data available
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-8 text-sm opacity-70">
          Last updated: {new Date().toLocaleString()}
        </div>
      </div>

      {/* Refresh Button */}
      <button
        onClick={fetchData}
        className="fixed bottom-6 right-6 bg-white/20 backdrop-blur-lg border border-white/30 rounded-full p-4 text-white hover:bg-white/30 transition-all duration-300 shadow-lg"
        title="Refresh Data"
      >
        🔄 Refresh
      </button>
    </div>
  );
};

export default Dashboard;