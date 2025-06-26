export default async function handler(req, res) {
  try {
    // Fetch signature count
    const progressResponse = await fetch('https://eci.ec.europa.eu/045/public/api/report/progression');
    const progressData = await progressResponse.json();
    
    // Fetch deadline info
    let deadline = null;
    try {
      const infoResponse = await fetch('https://eci.ec.europa.eu/045/public/api/initiative/description');
      const infoData = await infoResponse.json();
      const closingDate = infoData.initiativeInfo.closingDate;
      deadline = new Date(closingDate.split('/').reverse().join('-') + 'T23:59:59Z');
    } catch (e) {
      console.warn('Could not fetch deadline');
    }
    
    // Calculate stats
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
    
    // Create the data object
    const statsData = {
      signatures: progressData.signatureCount,
      goal: progressData.goal,
      timestamp: now.toISOString(),
      progress_percent: progressPercent,
      ...deadlineStats
    };
    
    // Save to GitHub
    await saveToGitHub(statsData);
    
    res.json({ 
      success: true, 
      signatures: progressData.signatureCount,
      progress: progressPercent.toFixed(2) + '%'
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function saveToGitHub(data) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER;
  const REPO_NAME = process.env.REPO_NAME;
  
  if (!GITHUB_TOKEN) return;
  
  try {
    // Update latest file
    await updateGitHubFile(
      `${REPO_OWNER}/${REPO_NAME}`,
      'eci_data_latest.json',
      JSON.stringify(data, null, 2),
      GITHUB_TOKEN
    );
    
    // Update complete file
    const completeData = await getCompleteData(`${REPO_OWNER}/${REPO_NAME}`, GITHUB_TOKEN);
    completeData.push(data);
    
    // Keep only last 30 days (8640 entries for 5-min intervals)
    if (completeData.length > 8640) {
      completeData.splice(0, completeData.length - 8640);
    }
    
    await updateGitHubFile(
      `${REPO_OWNER}/${REPO_NAME}`,
      'eci_data_complete.json',
      JSON.stringify(completeData, null, 2),
      GITHUB_TOKEN
    );
    
  } catch (error) {
    console.error('GitHub save error:', error);
  }
}

async function getCompleteData(repo, token) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/eci_data_complete.json`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (response.ok) {
      const fileData = await response.json();
      const content = Buffer.from(fileData.content, 'base64').toString();
      return JSON.parse(content);
    }
  } catch (e) {}
  return [];
}

async function updateGitHubFile(repo, filename, content, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
  
  // Get current file SHA
  let sha = null;
  try {
    const getResponse = await fetch(url, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (getResponse.ok) {
      const fileData = await getResponse.json();
      sha = fileData.sha;
    }
  } catch (e) {}
  
  // Update file
  const updateData = {
    message: `Update ${filename}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha && { sha })
  };
  
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updateData)
  });
}