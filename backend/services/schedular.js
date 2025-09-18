const cron = require('node-cron');
const Account = require('../models/Account'); // FIX 1: Correct model name
const AppState = require('../models/AppState');
const TargetUser = require('../models/TargetUser');
const telegramService = require('./telegramService');

const MESSAGES_PER_SESSION = 20; // Stop after 20 DMs per session

// Function to get random delay between 5-7 minutes
function getRandomDelay() {
    const minDelay = 5 * 60 * 1000; // 5 minutes in milliseconds
    const maxDelay = 7 * 60 * 1000; // 7 minutes in milliseconds
    const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    const delayInMinutes = (randomDelay / 1000 / 60).toFixed(1);
    console.log(`[Scheduler] Random delay selected: ${delayInMinutes} minutes (${randomDelay}ms)`);
    return randomDelay;
}

/**
 * Sanitizes a phone number for safe logging.
 */
function sanitizePhoneNumber(phone) {
    if (!phone || phone.length < 10) return "Invalid Phone";
    const countryCode = phone.slice(0, 3);
    const lastFour = phone.slice(-4);
    return `${countryCode}******${lastFour}`;
}

async function runSchedulerJob() {
    console.log(`[Scheduler] Waking up for the job at ${new Date().toLocaleString()}.`);

    let state = await AppState.findOne();
    if (!state) {
        console.log('[Scheduler] First run detected. Initializing AppState.');
        state = await new AppState().save();
    }

    const totalAccounts = await Account.countDocuments();
    if (totalAccounts === 0) {
        console.log('[Scheduler] No accounts found. Sleeping until next hour.');
        return;
    }

    const accountIndexToUse = state.nextAccountIndex;
    // FIX 2: More robust account selection
    const account = await Account.findOne().skip(accountIndexToUse);

    if (!account) {
        console.error(`[Scheduler] CRITICAL ERROR: Could not find account at index ${accountIndexToUse}. Resetting to 0.`);
        state.nextAccountIndex = 0;
        await state.save();
        return;
    }

    const sanitizedPhone = sanitizePhoneNumber(account.phone);
    console.log(`[Scheduler] Selected Account #${accountIndexToUse} (${sanitizedPhone}) for this hour.`);

    const statusResult = await telegramService.checkSpamStatus(account);
    
    if (statusResult.status === 'limited') {
        console.log(`[Scheduler] Account ${sanitizedPhone} is limited. Final status: ${statusResult.message}`);
        await Account.updateOne({ _id: account._id }, { status: 'limited', statusMessage: statusResult.message });
    } else {
        await Account.updateOne({ _id: account._id }, { status: 'healthy', statusMessage: statusResult.message });
        console.log(`[DEBUG] Querying for active users with limit ${MESSAGES_PER_SESSION}...`);
        const targets = await TargetUser.find({ status: 'active' }).limit(MESSAGES_PER_SESSION);
        console.log(`[DEBUG] Database query completed. Found ${targets.length} active users.`);

        if (targets.length === 0) {
            console.log('[Scheduler] No active users left to message!');
            
            // Let's check what users we do have
            const totalUsers = await TargetUser.countDocuments();
            const userStatusCounts = await TargetUser.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } }
            ]);
            console.log(`[DEBUG] Total users in database: ${totalUsers}`);
            console.log(`[DEBUG] User status breakdown:`, userStatusCounts);
        } else {
            console.log(`[Scheduler] Account ${sanitizedPhone} is healthy. Sending ${targets.length} messages.`);
            console.log(`[DEBUG] Target users found:`, targets.map(t => ({ id: t._id, username: t.username, status: t.status })));
            
            const client = telegramService.createClient(account);
            console.log(`[DEBUG] Created client for account ${sanitizedPhone}`);
            
            try {
                console.log(`[DEBUG] Attempting to connect client...`);
                await client.connect();
                console.log(`[DEBUG] Client connected successfully. Starting message loop...`);
                
                let messagesSent = 0;
                
                for (let i = 0; i < targets.length; i++) {
                    const target = targets[i];
                    console.log(`[DEBUG] Processing target ${i + 1}/${targets.length}: ${target.username}`);
                    
                    try {
                        const result = await telegramService.sendMessage(client, target.username);
                        console.log(`[DEBUG] Send message result for ${target.username}:`, result);
                        
                        if (result.success) {
                            messagesSent++;
                            await TargetUser.updateOne({ _id: target._id }, { status: 'messaged', lastMessageSentAt: new Date(), $inc: { messageCount: 1 } });
                            console.log(`[SUCCESS] Sent message ${messagesSent}/${MESSAGES_PER_SESSION} to ${target.username}. Marked as 'messaged'.`);
                            
                            // Check if we've reached the 20 DM limit
                            if (messagesSent >= MESSAGES_PER_SESSION) {
                                console.log(`[Scheduler] ✅ REACHED LIMIT: ${MESSAGES_PER_SESSION} messages sent successfully. Stopping bot session.`);
                                console.log(`[Scheduler] 🛑 Bot will need to be manually restarted for next session.`);
                                process.exit(0); // Gracefully stop the bot
                            }
                        } else {
                            console.log(`[FAILED] Failed to send to ${target.username}. Error type: ${result.errorType}`);
                            if (result.errorType === 'invalid_username') {
                                await TargetUser.updateOne({ _id: target._id }, { status: 'invalid_username' });
                                console.log(`[DEBUG] Marked ${target.username} as invalid_username`);
                            }
                            if (result.errorType === 'limited') {
                                console.warn(`[Scheduler] Hit PEER_FLOOD error. Stopping sends for this session.`);
                                await Account.updateOne({ _id: account._id }, { status: 'limited', statusMessage: 'Stopped due to PEER_FLOOD' });
                                break;
                            }
                        }
                    } catch (error) {
                        console.error(`[ERROR] Exception while processing target ${target.username}:`, error);
                    }
                    
                    // Only add delay if not the last message and not reached limit
                    if (i < targets.length - 1 && messagesSent < MESSAGES_PER_SESSION) {
                        const randomDelay = getRandomDelay();
                        console.log(`[DEBUG] Waiting ${(randomDelay / 1000 / 60).toFixed(1)} minutes before next message...`);
                        await new Promise(resolve => setTimeout(resolve, randomDelay));
                    }
                }
                console.log(`[DEBUG] Finished processing all targets. Total messages sent: ${messagesSent}`);
            } catch (error) {
                console.error(`[ERROR] Exception in message sending loop:`, error);
            } finally {
                console.log(`[DEBUG] Disconnecting client...`);
                if (client.connected) {
                    await client.disconnect();
                    console.log(`[DEBUG] Client disconnected`);
                } else {
                    console.log(`[DEBUG] Client was not connected, skipping disconnect`);
                }
            }
        }
    }

    state.nextAccountIndex = (accountIndexToUse + 1) % totalAccounts;
    await state.save();
    console.log(`[Scheduler] Job finished. Next account index is now #${state.nextAccountIndex}.`);
}

function startScheduler() {
    console.log('[Scheduler] Scheduler process started.');
    // Schedule to run at minute 0 of every hour.
    cron.schedule('0 * * * *', async () => {
        console.log('[Scheduler] Hourly cron job triggered.');
        await runSchedulerJob().catch(error => {
            console.error('[Scheduler] CRITICAL UNHANDLED ERROR in hourly job:', error);
        });
    }, {
        timezone: "Asia/Kolkata"
    });

    console.log('[Scheduler] Running one job immediately on startup...');
    runSchedulerJob().catch(error => console.error('[Scheduler] CRITICAL UNHANDLED ERROR in startup job:', error));
}


module.exports = { startScheduler, runSchedulerJob };
