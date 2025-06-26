import express from 'express';
import cron from 'node-cron';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection and create table
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS eci_data (
        id SERIAL PRIMARY KEY,
        signatures INTEGER NOT NULL,
        goal INTEGER NOT NULL,
        progress_percent DECIMAL(5,2) NOT NULL,
        deadline TIMESTAMP,
        days_remaining INTEGER,
        required_per_day DECIMAL(10,2),
        required_per_hour DECIMAL(10,2),
        required_per_minute DECIMAL(10,2),
        required_per_second DECIMAL(10,2),
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Add new columns if they don't exist (for existing tables)
    const newColumns = [
      'actual_per_minute DECIMAL(10,2)',
      'actual_per_hour DECIMAL(10,2)', 
      'actual_per_day DECIMAL(10,2)',
      'actual_per_week DECIMAL(10,2)',
      'on_track_daily BOOLEAN',
      'on_track_hourly BOOLEAN',
      'velocity_trend VARCHAR(20)'
    ];
    
    for (const column of newColumns) {
      try {
        await pool.query(`ALTER TABLE eci_data ADD COLUMN IF NOT EXISTS ${column}`);
      } catch (err) {
        // Column might already exist, ignore error
        console.log(`Column ${column.split(' ')[0]} already exists or error adding:`, err.message);
      }
    }
    
    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_eci_data_timestamp ON eci_data(timestamp);
    `);
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
  }
}

// Calculate actual rates and performance metrics
async function calculateRatesAndPerformance(currentSignatures, remaining, requiredPerDay, requiredPerHour) {
  try {
    // Get historical data for rate calculations
    const historicalData = await pool.query(`
      SELECT signatures, timestamp 
      FROM eci_data 
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY timestamp ASC
    `);
    
    let rates = {
      actual_per_minute: null,
      actual_per_hour: null,
      actual_per_day: null,
      actual_per_week: null,
      on_track_daily: null,
      on_track_hourly: null,
      velocity_trend: 'unknown'
    };
    
    if (historicalData.rows.length >= 2) {
      const rows = historicalData.rows;
      const latest = rows[rows.length - 1];
      const earliest = rows[0];
      
      // Calculate time difference in various units
      const timeDiffMs = new Date(latest.timestamp) - new Date(earliest.timestamp);
      const timeDiffMinutes = timeDiffMs / (1000 * 60);
      const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
      const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);
      const timeDiffWeeks = timeDiffDays / 7;
      
      // Calculate signature difference
      const signatureDiff = latest.signatures - earliest.signatures;
      
      // Calculate actual rates
      if (timeDiffMinutes > 0) {
        rates.actual_per_minute = signatureDiff / timeDiffMinutes;
        rates.actual_per_hour = signatureDiff / timeDiffHours;
        rates.actual_per_day = signatureDiff / timeDiffDays;
        rates.actual_per_week = signatureDiff / timeDiffWeeks;
      }
      
      // Performance tracking
      if (requiredPerDay && rates.actual_per_day) {
        rates.on_track_daily = rates.actual_per_day >= requiredPerDay;
      }
      
      if (requiredPerHour && rates.actual_per_hour) {
        rates.on_track_hourly = rates.actual_per_hour >= requiredPerHour;
      }
      
      // Velocity trend analysis (compare last 24h vs previous 24h)
      if (rows.length >= 4) {
        const last24h = rows.filter(r => new Date(r.timestamp) >= new Date(Date.now() - 24 * 60 * 60 * 1000));
        const prev24h = rows.filter(r => {
          const time = new Date(r.timestamp);
          return time >= new Date(Date.now() - 48 * 60 * 60 * 1000) && 
                 time < new Date(Date.now() - 24 * 60 * 60 * 1000);
        });
        
        if (last24h.length >= 2 && prev24h.length >= 2) {
          const recentRate = (last24h[last24h.length - 1].signatures - last24h[0].signatures) / 
                           ((new Date(last24h[last24h.length - 1].timestamp) - new Date(last24h[0].timestamp)) / (1000 * 60 * 60));
          const previousRate = (prev24h[prev24h.length - 1].signatures - prev24h[0].signatures) / 
                             ((new Date(prev24h[prev24h.length - 1].timestamp) - new Date(prev24h[0].timestamp)) / (1000 * 60 * 60));
          
          if (recentRate > previousRate * 1.1) {
            rates.velocity_trend = 'accelerating';
          } else if (recentRate < previousRate * 0.9) {
            rates.velocity_trend = 'slowing';
          } else {
            rates.velocity_trend = 'steady';
          }
        }
      }
    }
    
    return rates;
  } catch (error) {
    console.error('❌ Error calculating rates:', error.message);
    return {
      actual_per_minute: null,
      actual_per_hour: null,
      actual_per_day: null,
      actual_per_week: null,
      on_track_daily: null,
      on_track_hourly: null,
      velocity_trend: 'unknown'
    };
  }
}
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  pool.end();
  process.exit(0);
});

// Track app state
let isMonitorRunning = false;
let lastSuccessfulRun = null;
let errorCount = 0;

// Monitoring function
async function runMonitor() {
  if (isMonitorRunning) {
    console.log('⏭️ Monitor already running, skipping...');
    return;
  }

  isMonitorRunning = true;
  
  try {
    console.log('🔄 Running monitor...');
    
    // Fetch signature count with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const progressResponse = await fetch('https://eci.ec.europa.eu/045/public/api/report/progression', {
      signal: controller.signal,
      headers: { 'User-Agent': 'ECI-Monitor/1.0' }
    });
    
    clearTimeout(timeoutId);
    
    if (!progressResponse.ok) {
      throw new Error(`Progress API failed: ${progressResponse.status}`);
    }
    const progressData = await progressResponse.json();
    
    // Fetch deadline info
    let deadline = null;
    try {
      const infoController = new AbortController();
      const infoTimeoutId = setTimeout(() => infoController.abort(), 15000);
      
      const infoResponse = await fetch('https://eci.ec.europa.eu/045/public/api/initiative/description', {
        signal: infoController.signal,
        headers: { 'User-Agent': 'ECI-Monitor/1.0' }
      });
      
      clearTimeout(infoTimeoutId);
      
      if (infoResponse.ok) {
        const infoData = await infoResponse.json();
        const closingDate = infoData.initiativeInfo.closingDate;
        deadline = new Date(closingDate.split('/').reverse().join('-') + 'T23:59:59Z');
      }
    } catch (e) {
      console.warn('Could not fetch deadline info:', e.message);
    }
    
    const now = new Date();
    const progressPercent = (progressData.signatureCount / progressData.goal) * 100;
    const remaining = progressData.goal - progressData.signatureCount;
    
    let deadlineStats = {
      deadline: null,
      days_remaining: null,
      required_per_day: null,
      required_per_hour: null,
      required_per_minute: null,
      required_per_second: null
    };
    
    if (deadline) {
      const timeRemaining = deadline.getTime() - now.getTime();
      const daysLeft = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
      const hoursLeft = Math.floor(timeRemaining / (1000 * 60 * 60));
      const minutesLeft = Math.floor(timeRemaining / (1000 * 60));
      const secondsLeft = Math.floor(timeRemaining / 1000);
      
      deadlineStats = {
        deadline: deadline,
        days_remaining: daysLeft,
        required_per_day: daysLeft > 0 ? remaining / daysLeft : null,
        required_per_hour: hoursLeft > 0 ? remaining / hoursLeft : null,
        required_per_minute: minutesLeft > 0 ? remaining / minutesLeft : null,
        required_per_second: secondsLeft > 0 ? remaining / secondsLeft : null,
      };
    }
    
    // Calculate actual performance rates
    const performanceMetrics = await calculateRatesAndPerformance(
      progressData.signatureCount, 
      remaining, 
      deadlineStats.required_per_day, 
      deadlineStats.required_per_hour
    );
    
    // Save to database
    await pool.query(`
      INSERT INTO eci_data (
        signatures, goal, progress_percent, deadline, days_remaining,
        required_per_day, required_per_hour, required_per_minute, required_per_second,
        actual_per_minute, actual_per_hour, actual_per_day, actual_per_week,
        on_track_daily, on_track_hourly, velocity_trend,
        timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, [
      progressData.signatureCount,
      progressData.goal,
      progressPercent,
      deadlineStats.deadline,
      deadlineStats.days_remaining,
      deadlineStats.required_per_day,
      deadlineStats.required_per_hour,
      deadlineStats.required_per_minute,
      deadlineStats.required_per_second,
      performanceMetrics.actual_per_minute,
      performanceMetrics.actual_per_hour,
      performanceMetrics.actual_per_day,
      performanceMetrics.actual_per_week,
      performanceMetrics.on_track_daily,
      performanceMetrics.on_track_hourly,
      performanceMetrics.velocity_trend,
      now
    ]);
    
    lastSuccessfulRun = now;
    errorCount = 0;
    
    // Enhanced logging with performance info
    const trackingStatus = performanceMetrics.on_track_daily ? '🟢 ON TRACK' : '🔴 BEHIND';
    const trendEmoji = performanceMetrics.velocity_trend === 'accelerating' ? '📈' : 
                      performanceMetrics.velocity_trend === 'slowing' ? '📉' : '➡️';
    
    console.log(`✅ Saved: ${progressData.signatureCount} signatures (${progressPercent.toFixed(2)}%) ${trackingStatus} ${trendEmoji}`);
    if (performanceMetrics.actual_per_day) {
      console.log(`📊 Rate: ${performanceMetrics.actual_per_day.toFixed(0)}/day (need ${deadlineStats.required_per_day?.toFixed(0) || 'N/A'}/day)`);
    }
    
  } catch (error) {
    errorCount++;
    console.error(`❌ Monitor error (attempt ${errorCount}):`, error.message);
  } finally {
    isMonitorRunning = false;
  }
}

// Schedule cron job - every 5 minutes
cron.schedule('*/1 * * * *', () => {
  console.log('⏰ Cron triggered');
  runMonitor().catch(error => {
    console.error('❌ Cron job error:', error.message);
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    
    res.json({ 
      status: 'healthy',
      uptime: process.uptime(),
      database: 'connected',
      last_successful_run: lastSuccessfulRun,
      error_count: errorCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get latest data
app.get('/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM eci_data 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'No data available yet' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get historical data
app.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await pool.query(`
      SELECT * FROM eci_data 
      ORDER BY timestamp DESC 
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    res.json({
      data: result.rows,
      count: result.rows.length,
      limit,
      offset
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get performance analytics
app.get('/performance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        signatures,
        actual_per_minute,
        actual_per_hour,
        actual_per_day,
        actual_per_week,
        required_per_day,
        required_per_hour,
        on_track_daily,
        on_track_hourly,
        velocity_trend,
        timestamp
      FROM eci_data 
      ORDER BY timestamp DESC 
      LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'No performance data available yet' });
    }
    
    const data = result.rows[0];
    
    // Calculate performance ratios
    const performance = {
      ...data,
      daily_performance_ratio: data.required_per_day ? (data.actual_per_day / data.required_per_day) : null,
      hourly_performance_ratio: data.required_per_hour ? (data.actual_per_hour / data.required_per_hour) : null,
      status: data.on_track_daily ? 'on_track' : 'behind_schedule',
      trend_indicator: data.velocity_trend
    };
    
    res.json(performance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trend analysis
app.get('/trends', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    
    const result = await pool.query(`
      SELECT 
        signatures,
        actual_per_day,
        actual_per_hour,
        velocity_trend,
        on_track_daily,
        timestamp
      FROM eci_data 
      WHERE timestamp >= NOW() - INTERVAL '${days} days'
      ORDER BY timestamp ASC
    `);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'No trend data available yet' });
    }
    
    // Calculate trend statistics
    const rows = result.rows;
    const avgDailyRate = rows.reduce((sum, row) => sum + (row.actual_per_day || 0), 0) / rows.length;
    const onTrackPercentage = (rows.filter(row => row.on_track_daily).length / rows.length) * 100;
    
    const trendCounts = rows.reduce((acc, row) => {
      acc[row.velocity_trend] = (acc[row.velocity_trend] || 0) + 1;
      return acc;
    }, {});
    
    res.json({
      period_days: days,
      data_points: rows.length,
      average_daily_rate: avgDailyRate,
      on_track_percentage: onTrackPercentage,
      trend_distribution: trendCounts,
      data: rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/history-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_entries,
        MIN(timestamp) as first_entry,
        MAX(timestamp) as last_entry,
        MAX(signatures) as latest_signatures,
        MIN(signatures) as first_signatures,
        (MAX(signatures) - MIN(signatures)) as total_growth,
        AVG(signatures) as average_signatures
      FROM eci_data
    `);
    
    if (result.rows.length === 0) {
      return res.json({ message: 'No data available yet' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual trigger endpoint
app.get('/monitor', async (req, res) => {
  console.log('🔄 Manual trigger received');
  try {
    await runMonitor();
    res.json({ 
      success: true, 
      message: 'Monitor executed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Dashboard endpoint
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({ 
    service: 'Stop Killing Games ECI Monitor',
    status: 'running',
    uptime: process.uptime(),
    cron: 'Every 5 minutes',
    database: 'PostgreSQL',
    endpoints: {
      health: '/health',
      latest: '/latest',
      history: '/history?limit=100&offset=0',
      history_stats: '/history-stats',
      performance: '/performance',
      trends: '/trends?days=7',
      manual_trigger: '/monitor',
      dashboard: '/dashboard'
    },
    last_successful_run: lastSuccessfulRun,
    error_count: errorCount,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🗄️ Initializing database...');
  
  await initializeDatabase();
  
  console.log('⏰ Cron job scheduled for every 5 minutes');
  console.log('🌐 Available endpoints: /, /health, /latest, /history, /history-stats, /performance, /trends, /monitor, /dashboard');
  
  // Run initial monitor after startup
  setTimeout(() => {
    console.log('🔄 Running initial monitor check...');
    runMonitor();
  }, 3000);
});