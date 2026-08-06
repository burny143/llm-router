const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { getFilePath } = require('./state-store');

async function setupQwenCookie() {
  const browser = await chromium.launch({ headless: false, headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('Opening Qwen chat in browser window...');
  console.log('Please log in to Qwen (https://chat.qwen.ai) and send one test message.');

  // Navigate to Qwen chat
  await page.goto('https://chat.qwen.ai');

  // Wait for the chat interface to load
  await page.waitForSelector('textarea[placeholder="Type a message..."]', { state: 'visible' });

  console.log('Ready! Please log in if prompted and send a test message in the chat.');

  let capturedRequest = null;
  let cookies = null;
  let requestPayload = null;

  // Set up request interception
  await page.route('**/*.json', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.url().includes('/chat')) {
      console.log('Captured Qwen API request:', request.url());
      capturedRequest = request;
      cookies = await context.cookies();
      try {
        requestPayload = JSON.parse(request.postData() || '{}');
      } catch (e) {
        requestPayload = request.postData();
      }
      await route.continue();
    } else {
      await route.continue();
    }
  });

  // Listen for network requests for the chat endpoint
  const qwenUrl = await page.evaluate(() => {
    return window.location.href;
  });

  // Prompt user to send a test message
  await page.keyboard.type('Hello, this is a test message from LLM Proxy Router!');
  await page.waitForSelector('button[aria-label="Send message"]', { state: 'visible' }).then(async button => {
    await button.click();
  });

  console.log('Test message sent! Waiting for API response...');

  // Wait for the API request to be captured
  let attempts = 0;
  while (!capturedRequest && attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    console.log(`Waiting for request capture (${attempts}/60)...`);
  }

  if (!capturedRequest) {
    console.error('Failed to capture Qwen API request. Please make sure you are on the Qwen chat page and have sent a message.');
    await browser.close();
    process.exit(1);
  }

  console.log('\n=== Captured Qwen API Details ===');
  console.log('Request URL:', capturedRequest.url());
  console.log('Method:', capturedRequest.method());
  console.log('Headers:', JSON.stringify(capturedRequest.headers(), null, 2));
  console.log('Payload:', JSON.stringify(requestPayload, null, 2));

  // Extract cookies
  const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

  // Save cookies to .env
  const envPath = getFilePath('env');
  try {
    const envConfig = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
    envConfig.QWEN_COOKIE = cookieString;
    fs.writeFileSync(envPath, Object.entries(envConfig).map(([k, v]) => `${k}=${v}`).join('\n'));
    console.log('\n✓ Cookie saved to .env');
  } catch (err) {
    console.error('Failed to save cookie to .env:', err.message);
    await browser.close();
    process.exit(1);
  }

  // Update ProviderConfig.csv
  const configPath = getFilePath('providerConfig');
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const lines = configContent.trim().split(/\r?\n/);

  // Check if Qwen exists
  let qwenIndex = -1;
  const originalHeader = lines[0];
  const headerColumns = originalHeader.split(',');

  // Add authType column if not exists
  if (!headerColumns.includes('authType')) {
    headerColumns.push('authType');
    lines[0] = headerColumns.join(',');
  }

  // Find Qwen entry
  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(',');
    if (columns[0] && columns[0].trim() === 'Qwen') {
      qwenIndex = i;
      break;
    }
  }

  // Extract baseURL from request
  const requestUrl = capturedRequest.url();
  const baseUrl = requestUrl.includes('/chat') ? requestUrl.split('/chat')[0] : requestUrl;

  // Build or update Qwen entry
  const qwenEntry = [
    'Qwen',
    baseUrl,
    'QWEN_COOKIE',
    '',
    'Cookie'
  ];

  if (qwenIndex >= 0) {
    // Update existing entry
    const currentEntry = lines[qwenIndex].split(',');
    currentEntry[0] = qwenEntry[0]; // provider
    currentEntry[1] = qwenEntry[1]; // baseURL
    currentEntry[2] = qwenEntry[2]; // apiKeyEnv
    currentEntry[3] = qwenEntry[3]; // modelsEndpoint
    currentEntry[4] = qwenEntry[4]; // authType
    lines[qwenIndex] = currentEntry.join(',');
    console.log('✓ Updated existing Qwen entry');
  } else {
    // Add new entry
    lines.push(qwenEntry.join(','));
    console.log('✓ Added new Qwen entry');
  }

  // Write updated CSV
  fs.writeFileSync(configPath, lines.join('\n'));
  console.log('✓ ProviderConfig.csv updated');

  // Save request rules
  const rules = {
    sampleRequest: {
      url: capturedRequest.url(),
      method: capturedRequest.method(),
      headers: capturedRequest.headers(),
      payload: requestPayload
    },
    requiredHeaders: {
      'User-Agent': capturedRequest.headers()['user-agent'] || capturedRequest.headers()['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': capturedRequest.headers()['origin'] || 'https://chat.qwen.ai',
      'Referer': capturedRequest.headers()['referer'] || 'https://chat.qwen.ai/',
      'Accept': capturedRequest.headers()['accept'] || 'application/json',
      'Content-Type': capturedRequest.headers()['content-type'] || 'application/json',
      'Cookie': capturedRequest.headers()['cookie'] || ''
    }
  };

  const rulesPath = getFilePath('webProviderRules');
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
  console.log('✓ Web provider rules saved to data/web-provider-rules.json');

  // Reload dotenv to update process.env
  dotenv.config({ path: envPath, override: true });

  await browser.close();

  console.log('\n=== Qwen Cookie Setup Complete ===');
  console.log('The following actions were completed:');
  console.log('1. ✓ Qwen API request captured');
  console.log('2. ✓ Cookie saved to .env as QWEN_COOKIE');
  console.log('3. ✓ ProviderConfig.csv updated (Qwen added with authType=Cookie)');
  console.log('4. ✓ Web provider rules saved to web-provider-rules.json');
  console.log('\nNext steps:');
  console.log('- Restart the LLM Proxy Router app to load the new provider');
  console.log('- The Qwen provider will now use cookie authentication instead of Bearer tokens');
  console.log('- Qwen responses will be automatically translated to OpenAI format');

  process.exit(0);
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

setupQwenCookie().catch(err => {
  console.error('Error in Qwen cookie setup:', err);
  process.exit(1);
});
