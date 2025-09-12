const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const template = require('../config/template');

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
    const client = new TelegramClient(session, parseInt(account.apiId), account.apiHash, {
        connectionRetries: 3,
        timeout: 30000,
        retryDelay: 1000
    });
    
    let lastKnownBotReply = "No reply received from SpamInfoBot.";

    try {
        await client.connect();

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
        return { status: 'limited', message: `Error: ${error.message}` };
    } finally {
        if (client.connected) {
            await client.disconnect();
        }
    }
}


/**
 * Sends a single message to a target user.
 * @param {object} account - The Mongoose document for the Telegram account.
 * @param {string} targetUsername - The username of the recipient.
 * @returns {Promise<{success: boolean, errorType?: 'limited' | 'generic'}>}
 */
async function sendMessage(account, targetUsername) {
    const session = new StringSession(account.sessionString);
    const client = new TelegramClient(session, parseInt(account.apiId), account.apiHash, {
        timeout: 30000,
        retryDelay: 1000
    });
    const message = template[Math.floor(Math.random() * template.length)];

    try {
        await client.connect();
        await client.sendMessage(targetUsername, { message });
        return { success: true };
    } catch (error) {
        console.error(`Failed to send message from ${account.phone} to ${targetUsername}:`, error.constructor.name);
        if (error.constructor.name === 'FloodWaitError' || error.errorMessage === 'PEER_FLOOD') {
            return { success: false, errorType: 'limited' };
        }
        return { success: false, errorType: 'generic' };
    } finally {
        await client.disconnect();
    }
}

module.exports = { checkSpamStatus, sendMessage };
