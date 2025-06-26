import express from 'express';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;

// Keep process alive
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
});

// Monitoring function with proper error handling
async function runMonitor() {
  try {
    console.log('🔄 Running monitor...');
    
    // Fetch signature count
    const progressResponse = await fetch('https://eci.ec.europa.eu/045/public/api/report/progression');
    if (!progressResponse.ok) {
      throw new Error(`Progress API failed: ${progressResponse.status}`);
    }
    const progressData = await progressResponse.json();
    
    // Fetch deadline info
    let deadline = null;
    try {
      const infoResponse = await fetch('https://eci.ec.europa.eu/045/public/api/initiative/description');
      if (infoResponse.ok) {
        const infoData = await infoResponse.json();
        const closingDate = infoData.initiativeInfo.closingDate;
        deadline = new Date(closingDate.split('/').reverse().join('-') + 'T23:59:59Z');
      }
    } catch (e) {
      console.warn('Could not fetch deadline info');
    }
    
    const now = new Date();
    const progressPercent = (progressData.signatureCount / progressData.goal) * 100;
    const remaining = progressData.goal - progressData.signatureCount;
    
    let deadlineStats = {};
    if (deadline) {
      const timeRemaining = deadline.getTime() - now.getTime();
      const daysLeft = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
      const hoursLeft = Math.floor(timeRemaining / (1000 * 60 * 60));
      const minutesLeft = Math.floor(timeRemaining / (1000 * 60));
      const secondsLeft = Math.floor(timeRemaining / 1000);
      
      deadlineStats = {
        deadline: deadline.toISOString(),
        days_remaining: daysLeft,
        required_per_week: daysLeft > 0 ? (remaining / daysLeft) * 7 : null,
        required_per_day: daysLeft > 0 ? remaining / daysLeft : null,
        required_per_hour: hoursLeft > 0 ? remaining / hoursLeft : null,
        required_per_minute: minutesLeft > 0 ? remaining / minutesLeft : null,
        required_per_second: secondsLeft > 0 ? remaining / secondsLeft : null,
      };
    }
    
    const statsData = {
      signatures: progressData.signatureCount,
      goal: progressData.goal,
      timestamp: now.toISOString(),
      progress_percent: progressPercent,
      ...deadlineStats
    };
    
    await saveToGitHub(statsData);
    console.log(`✅ Updated: ${progressData.signatureCount} signatures (${progressPercent.toFixed(2)}%)`);
    
  } catch (error) {
    console.error('❌ Monitor error:', error.message);
  }
}

// GitHub save function with proper error handling
async function saveToGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.warn('⚠️ Missing GitHub credentials - skipping save');
    return;
  }
  
  try {
    await updateGitHubFile(`${REPO_OWNER}/${REPO_NAME}`, 'eci_data_latest.json', JSON.stringify(data, null, 2), GITHUB_TOKEN);
    console.log('💾 Saved to GitHub successfully');
  } catch (error) {
    console.error('❌ GitHub save error:', error.message);
  }
}

async function updateGitHubFile(repo, filename, content, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
  
  // Get current file SHA if it exists
  let sha = null;
  try {
    const getResponse = await fetch(url, { 
      headers: { 'Authorization': `token ${token}` } 
    });
    if (getResponse.ok) {
      const fileData = await getResponse.json();
      sha = fileData.sha;
    }
  } catch (e) {
    // File doesn't exist yet
  }
  
  // Update file
  const updateData = {
    message: `Update ECI data - ${new Date().toISOString()}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha && { sha })
  };
  
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 
      'Authorization': `token ${token}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify(updateData)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API failed: ${response.status} - ${errorText}`);
  }
}

// Schedule cron job - every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('⏰ Cron triggered');
  runMonitor();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
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
    endpoints: {
      health: '/health',
      manual_trigger: '/monitor'
    },
    timestamp: new Date().toISOString()
  });
});

// Start server with proper binding
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('⏰ Cron job scheduled for every 5 minutes');
  console.log('🌐 Available endpoints: /, /health, /monitor');
  
  // Run initial monitor after startup
  setTimeout(() => {
    console.log('🔄 Running initial monitor check...');
    runMonitor();
  }, 3000);
});