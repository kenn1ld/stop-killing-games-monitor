import express from 'express';
import cron from 'node-cron';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;

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
    
    // Create index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_eci_data_timestamp ON eci_data(timestamp);
    `);
    
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
  }
}

// Keep process alive
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
    
    // Save to database
    await pool.query(`
      INSERT INTO eci_data (
        signatures, goal, progress_percent, deadline, days_remaining,
        required_per_day, required_per_hour, required_per_minute, required_per_second,
        timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      now
    ]);
    
    lastSuccessfulRun = now;
    errorCount = 0;
    console.log(`✅ Saved to database: ${progressData.signatureCount} signatures (${progressPercent.toFixed(2)}%)`);
    
  } catch (error) {
    errorCount++;
    console.error(`❌ Monitor error (attempt ${errorCount}):`, error.message);
  } finally {
    isMonitorRunning = false;
  }
}

// Schedule cron job - every 5 minutes
cron.schedule('*/5 * * * *', () => {
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

// Get history stats
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
      manual_trigger: '/monitor'
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
  console.log('🌐 Available endpoints: /, /health, /latest, /history, /history-stats, /monitor');
  
  // Run initial monitor after startup
  setTimeout(() => {
    console.log('🔄 Running initial monitor check...');
    runMonitor();
  }, 3000);
});