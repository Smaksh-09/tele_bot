const cron = require('node-cron');
const Account = require('../models/Account'); // FIX 1: Correct model name
const AppState = require('../models/AppState');
const TargetUser = require('../models/TargetUser');
const telegramService = require('./telegramService');

const MESSAGES_PER_HOUR = 50;

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
        const targets = await TargetUser.find({ status: 'active' }).limit(MESSAGES_PER_HOUR);

        if (targets.length === 0) {
            console.log('[Scheduler] No active users left to message!');
        } else {
            console.log(`[Scheduler] Account ${sanitizedPhone} is healthy. Sending ${targets.length} messages.`);
            const delayBetweenMessages = (3600 / MESSAGES_PER_HOUR) * 1000;
            const client = telegramService.createClient(account);
            try {
                await client.connect();
                for (const target of targets) {
                    const result = await telegramService.sendMessage(client, target.username);
                    if (result.success) {
                        await TargetUser.updateOne({ _id: target._id }, { status: 'messaged', lastMessageSentAt: new Date(), $inc: { messageCount: 1 } });
                        console.log(`Sent to ${target.username}. Marked as 'messaged'.`);
                    } else {
                        if (result.errorType === 'invalid_username') {
                            await TargetUser.updateOne({ _id: target._id }, { status: 'invalid_username' });
                        }
                        if (result.errorType === 'limited') {
                            console.warn(`[Scheduler] Hit PEER_FLOOD error. Stopping sends for this hour.`);
                            await Account.updateOne({ _id: account._id }, { status: 'limited', statusMessage: 'Stopped due to PEER_FLOOD' });
                            break;
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
                }
            } finally {
                if (client.connected) {
                    await client.disconnect();
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
    });

    // Optional: Run a job on startup for immediate testing.
    // console.log('[Scheduler] Running one job immediately on startup...');
    // runSchedulerJob().catch(error => console.error('[Scheduler] CRITICAL UNHANDLED ERROR in startup job:', error));
}


module.exports = { startScheduler, runSchedulerJob };
