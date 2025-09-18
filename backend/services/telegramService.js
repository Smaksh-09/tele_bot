const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const template = require('../config/template');
const fs = require('fs');
const path = require('path');

// Proxy management
let proxies = [];
let proxyIndex = 0;

// Load proxies from file
function loadProxies() {
    try {
        const proxyFile = path.join(__dirname, '../proxies/proxies__.txt');
        const proxyData = fs.readFileSync(proxyFile, 'utf8');
        proxies = proxyData.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [host, port, username, password] = line.trim().split(':');
                return {
                    host,
                    port: parseInt(port),
                    username,
                    password
                };
            });
        console.log(`[ProxyManager] Loaded ${proxies.length} proxies`);
    } catch (error) {
        console.error('[ProxyManager] Error loading proxies:', error);
        proxies = [];
    }
}

// Get proxy for account based on account index
function getProxyForAccount(accountIndex) {
    if (proxies.length === 0) {
        loadProxies();
    }
    
    if (proxies.length === 0) {
        console.warn('[ProxyManager] ⚠️  No proxies available, using direct connection');
        return null;
    }
    
    // Assign proxy based on account index (round-robin)
    const proxyIndex = accountIndex % proxies.length;
    const proxy = proxies[proxyIndex];
    console.log(`[ProxyManager] ✅ Assigned proxy ${proxyIndex + 1}/${proxies.length} (${proxy.host}:${proxy.port}) to account index ${accountIndex}`);
    console.log(`[ProxyManager] 🔐 Proxy credentials: ${proxy.username}:${proxy.password ? '***' : 'no password'}`);
    return proxy;
}

// Initialize proxies on startup
loadProxies();

// Log proxy assignments for accounts
if (proxies.length > 0) {
    console.log(`[ProxyManager] Proxy assignments will be:`);
    for (let i = 0; i < 20; i++) { // Assuming 20 accounts (0-19)
        const proxyIndex = i % proxies.length;
        const proxy = proxies[proxyIndex];
        console.log(`[ProxyManager] Account ${i} -> Proxy ${proxyIndex + 1} (${proxy.host}:${proxy.port})`);
    }
}

// --- Configuration for the Spam Check ---
const MAX_SPAM_CHECK_RETRIES = 5;
const SPAM_CHECK_RETRY_DELAY_MS = 10000; // 10 seconds between retries

/**
 * Checks the account's spam status by interacting with @SpamInfoBot.
 * It will retry up to 5 times if the account is initially reported as restricted.
 * @param {object} account - The Mongoose document for the Telegram account.
 * @returns {Promise<{status: 'healthy' | 'limited', message: string}>} The final status.
 */
async function checkSpamStatus(account) {
    const session = new StringSession(account.sessionString);
    const proxy = getProxyForAccount(account.accountIndex);
    
    const clientOptions = {
        connectionRetries: 3,
        timeout: 30000,
        retryDelay: 1000
    };
    
    // Add proxy configuration if available (gramjs format)
    if (proxy) {
        clientOptions.proxy = {
            ip: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            socksType: 5, // SOCKS5
            timeout: 10 // Connection timeout in seconds
        };
        console.log(`[SpamCheck] ✅ PROXY CONFIGURED: ${proxy.host}:${proxy.port} (SOCKS5) for account ${account.accountIndex}`);
    }
    
    const client = new TelegramClient(session, parseInt(account.apiId), account.apiHash, clientOptions);
    
    let lastKnownBotReply = "No reply received from SpamInfoBot.";

    try {
        console.log(`[SpamCheck] 🔧 Client proxy config:`, clientOptions?.proxy ? 'ENABLED' : 'DISABLED');
        if (clientOptions?.proxy) {
            console.log(`[SpamCheck] 🔗 Connecting through proxy: ${clientOptions.proxy.ip}:${clientOptions.proxy.port}`);
        }
        await client.connect();
        console.log(`[SpamCheck] ✅ Connected successfully through ${clientOptions?.proxy ? 'PROXY' : 'DIRECT'} connection.`);

        for (let attempt = 1; attempt <= MAX_SPAM_CHECK_RETRIES; attempt++) {
            console.log(`[Spam Check] Account ${account.phone}: Attempt ${attempt}/${MAX_SPAM_CHECK_RETRIES}...`);
            await client.sendMessage('SpamBot', { message: '/start' });

            // Wait a few seconds for the bot to reply
            await new Promise(resolve => setTimeout(resolve, 5000));

            const history = await client.getMessages('SpamBot', { limit: 1 });
            const botReply = history[0]?.message;
            lastKnownBotReply = botReply || lastKnownBotReply;

            // We consider an account restricted if the reply contains these keywords.
            // Telegram's positive messages can vary, so checking for negative ones is more reliable.
            const isRestricted = botReply && (botReply.toLowerCase().includes('restricted') || botReply.toLowerCase().includes('limited') || botReply.toLowerCase().includes('sorry'));

            if (!isRestricted) {
                // SUCCESS: The account is not restricted.
                console.log(`[Spam Check] Account ${account.phone} is healthy. Reply: "${botReply}"`);
                return { status: 'healthy', message: botReply }; // Exit the function immediately with a good status.
            }

            // If we're here, the account is currently restricted.
            console.log(`[Spam Check] Account ${account.phone} is restricted. Reply: "${botReply}"`);

            // If this was the last attempt, we don't need to wait again.
            if (attempt < MAX_SPAM_CHECK_RETRIES) {
                console.log(`[Spam Check] Waiting for ${SPAM_CHECK_RETRY_DELAY_MS / 1000}s before retrying...`);
                await new Promise(resolve => setTimeout(resolve, SPAM_CHECK_RETRY_DELAY_MS));
            }
        }

        // FAILURE: If the loop completes, it means all retry attempts failed.
        console.log(`[Spam Check] Account ${account.phone} remains restricted after ${MAX_SPAM_CHECK_RETRIES} attempts.`);
        return { status: 'limited', message: lastKnownBotReply };

    } catch (error) {
        console.error(`[Spam Check] Critical error during spam check for ${account.phone}:`, error);
        if (error.message && error.message.includes('proxy')) {
            console.error(`[Spam Check] 🚨 PROXY CONNECTION FAILED for ${account.phone}`);
            console.error(`[Spam Check] 🔧 Proxy config was: ${clientOptions?.proxy ? JSON.stringify(clientOptions.proxy) : 'none'}`);
        }
        return { status: 'limited', message: `Error: ${error.message}` };
    } finally {
        if (client.connected) {
            await client.disconnect();
        }
    }
}


/**
 * Creates a Telegram client for an account with proxy support.
 * @param {object} account - The Mongoose document for the Telegram account.
 * @returns {TelegramClient} The created client.
 */
function createClient(account) {
    const session = new StringSession(account.sessionString);
    const proxy = getProxyForAccount(account.accountIndex);
    
    const clientOptions = {
        connectionRetries: 3,
        timeout: 30000,
        retryDelay: 1000
    };
    
    // Add proxy configuration if available (gramjs format)
    if (proxy) {
        clientOptions.proxy = {
            ip: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            socksType: 5, // SOCKS5
            timeout: 10 // Connection timeout in seconds
        };
        console.log(`[TelegramService] ✅ PROXY CONFIGURED: ${proxy.host}:${proxy.port} (SOCKS5) for account ${account.accountIndex}`);
        console.log(`[TelegramService] 🔐 Proxy auth: ${proxy.username}:${proxy.password ? '***' : 'no password'}`);
    } else {
        console.log(`[TelegramService] ⚠️  NO PROXY: Direct connection for account ${account.accountIndex}`);
    }
    
    return new TelegramClient(session, parseInt(account.apiId), account.apiHash, clientOptions);
}

// Template rotation counter
let templateIndex = 0;

/**
 * Sends a single message to a target user using an existing client.
 * @param {TelegramClient} client - The connected Telegram client.
 * @param {string} targetUsername - The username of the recipient.
 * @returns {Promise<{success: boolean, errorType?: 'limited' | 'invalid_username' | 'generic'}>}
 */
async function sendMessage(client, targetUsername) {
    console.log(`[TelegramService] Starting sendMessage to ${targetUsername}`);
    
    if (!client) {
        console.error(`[TelegramService] ERROR: No client provided`);
        return { success: false, errorType: 'generic' };
    }
    
    if (!client.connected) {
        console.error(`[TelegramService] ERROR: Client is not connected`);
        return { success: false, errorType: 'generic' };
    }
    
    // Rotate through templates sequentially for better variety
    const message = template[templateIndex % template.length];
    templateIndex++;
    console.log(`[TelegramService] Selected template ${((templateIndex - 1) % template.length) + 1}/${template.length}: "${message.substring(0, 80)}..."`);
    console.log(`[TelegramService] Target username: "${targetUsername}"`);

    try {
        console.log(`[TelegramService] Sending message to ${targetUsername}...`);
        await client.sendMessage(targetUsername, { message });
        console.log(`[TelegramService] SUCCESS: Message sent to ${targetUsername}`);
        return { success: true };
    } catch (error) {
        console.error(`[TelegramService] FAILED to send message to ${targetUsername}:`);
        console.error(`[TelegramService] Error name: ${error.constructor.name}`);
        console.error(`[TelegramService] Error message: ${error.message}`);
        console.error(`[TelegramService] Error code: ${error.code}`);
        console.error(`[TelegramService] Error details:`, error);
        
        if (error.constructor.name === 'FloodWaitError' || error.errorMessage === 'PEER_FLOOD') {
            console.log(`[TelegramService] Detected flood/rate limit error`);
            return { success: false, errorType: 'limited' };
        }
        if (error.errorMessage && (error.errorMessage.includes('USERNAME_INVALID') || error.errorMessage.includes('USER_ID_INVALID'))) {
            console.log(`[TelegramService] Detected invalid username error`);
            return { success: false, errorType: 'invalid_username' };
        }
        console.log(`[TelegramService] Treating as generic error`);
        return { success: false, errorType: 'generic' };
    }
}

module.exports = { checkSpamStatus, sendMessage, createClient };
