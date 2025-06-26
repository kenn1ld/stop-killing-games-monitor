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
    
    // Save both latest and add to history
    await Promise.all([
      saveLatestToGitHub(statsData),
      addToHistoryOnGitHub(statsData)
    ]);
    
    console.log(`✅ Updated: ${progressData.signatureCount} signatures (${progressPercent.toFixed(2)}%)`);
    
  } catch (error) {
    console.error('❌ Monitor error:', error.message);
  }
}

// Save latest data (existing functionality)
async function saveLatestToGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.warn('⚠️ Missing GitHub credentials - skipping latest save');
    return;
  }
  
  try {
    await updateGitHubFile(`${REPO_OWNER}/${REPO_NAME}`, 'eci_data_latest.json', JSON.stringify(data, null, 2), GITHUB_TOKEN);
    console.log('💾 Latest data saved to GitHub');
  } catch (error) {
    console.error('❌ Latest GitHub save error:', error.message);
  }
}

// Add to history file
async function addToHistoryOnGitHub(newData) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    console.warn('⚠️ Missing GitHub credentials - skipping history save');
    return;
  }
  
  try {
    const repo = `${REPO_OWNER}/${REPO_NAME}`;
    const filename = 'eci_data_history.json';
    
    // Get existing history
    let existingHistory = [];
    try {
      const existingData = await getGitHubFileContent(repo, filename, GITHUB_TOKEN);
      if (existingData) {
        existingHistory = JSON.parse(existingData);
        if (!Array.isArray(existingHistory)) {
          existingHistory = [];
        }
      }
    } catch (e) {
      console.log('📝 Creating new history file');
      existingHistory = [];
    }
    
    // Add new entry to history
    existingHistory.push(newData);
    
    // Optional: Keep only last 10,000 entries to prevent file from getting too large
    if (existingHistory.length > 10000) {
      existingHistory = existingHistory.slice(-10000);
      console.log('🔄 Trimmed history to last 10,000 entries');
    }
    
    // Save updated history
    const historyContent = JSON.stringify(existingHistory, null, 2);
    await updateGitHubFile(repo, filename, historyContent, GITHUB_TOKEN);
    console.log(`📚 History updated (${existingHistory.length} total entries)`);
    
  } catch (error) {
    console.error('❌ History GitHub save error:', error.message);
  }
}

// Helper function to get file content from GitHub
async function getGitHubFileContent(repo, filename, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
  
  const response = await fetch(url, {
    headers: { 'Authorization': `token ${token}` }
  });
  
  if (!response.ok) {
    if (response.status === 404) {
      return null; // File doesn't exist
    }
    throw new Error(`Failed to get file: ${response.status}`);
  }
  
  const data = await response.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
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

// New endpoint to get history stats
app.get('/history-stats', async (req, res) => {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
    return res.status(500).json({ error: 'Missing GitHub credentials' });
  }
  
  try {
    const repo = `${REPO_OWNER}/${REPO_NAME}`;
    const historyContent = await getGitHubFileContent(repo, 'eci_data_history.json', GITHUB_TOKEN);
    
    if (!historyContent) {
      return res.json({ message: 'No history data available yet' });
    }
    
    const history = JSON.parse(historyContent);
    
    res.json({
      total_entries: history.length,
      first_entry: history[0]?.timestamp,
      last_entry: history[history.length - 1]?.timestamp,
      latest_signatures: history[history.length - 1]?.signatures,
      first_signatures: history[0]?.signatures,
      total_growth: history.length > 1 ? history[history.length - 1]?.signatures - history[0]?.signatures : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({ 
    service: 'Stop Killing Games ECI Monitor',
    status: 'running',
    uptime: process.uptime(),
    cron: 'Every 5 minutes',
    files: {
      latest: 'eci_data_latest.json',
      history: 'eci_data_history.json'
    },
    endpoints: {
      health: '/health',
      manual_trigger: '/monitor',
      history_stats: '/history-stats'
    },
    timestamp: new Date().toISOString()
  });
});

// Start server with proper binding
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('⏰ Cron job scheduled for every 5 minutes');
  console.log('🌐 Available endpoints: /, /health, /monitor, /history-stats');
  console.log('📁 Will maintain: eci_data_latest.json & eci_data_history.json');
  
  // Run initial monitor after startup
  setTimeout(() => {
    console.log('🔄 Running initial monitor check...');
    runMonitor();
  }, 3000);
});