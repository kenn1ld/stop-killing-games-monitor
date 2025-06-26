import express from 'express';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;

// Your monitoring function (same logic as Vercel)
async function runMonitor() {
  try {
    const progressResponse = await fetch('https://eci.ec.europa.eu/045/public/api/report/progression');
    const progressData = await progressResponse.json();
    
    let deadline = null;
    try {
      const infoResponse = await fetch('https://eci.ec.europa.eu/045/public/api/initiative/description');
      const infoData = await infoResponse.json();
      const closingDate = infoData.initiativeInfo.closingDate;
      deadline = new Date(closingDate.split('/').reverse().join('-') + 'T23:59:59Z');
    } catch (e) {}
    
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
    console.log(`✅ Updated: ${progressData.signatureCount} signatures`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// GitHub save function (same as before)
async function saveToGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN) return;
  
  try {
    await updateGitHubFile(`${REPO_OWNER}/${REPO_NAME}`, 'eci_data_latest.json', JSON.stringify(data, null, 2), GITHUB_TOKEN);
  } catch (error) {
    console.error('GitHub save error:', error);
  }
}

async function updateGitHubFile(repo, filename, content, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
  
  let sha = null;
  try {
    const getResponse = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    if (getResponse.ok) {
      const fileData = await getResponse.json();
      sha = fileData.sha;
    }
  } catch (e) {}
  
  const updateData = {
    message: `Update ${filename}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha && { sha })
  };
  
  await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  });
}

// Schedule cron job - every 5 minutes
cron.schedule('*/5 * * * *', runMonitor);

// API endpoint for manual testing
app.get('/monitor', async (req, res) => {
  await runMonitor();
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'ECI Monitor running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('⏰ Cron job scheduled for every 5 minutes');
});