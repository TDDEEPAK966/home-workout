const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

const PROJECT_ID = 'home-workout-planner-4e10f';
const DATABASE_URL = 'https://home-workout-planner-4e10f-default-rtdb.asia-southeast1.firebasedatabase.app';
const REMINDERS_PATH = 'workout_planner_reminder_users';

function initializeFirebase() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON GitHub Actions secret.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain the full service-account JSON.');
  }
  if (serviceAccount.project_id !== PROJECT_ID) {
    throw new Error(`The service-account key must belong to Firebase project ${PROJECT_ID}.`);
  }

  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
}

function getLocalDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

function getAddedActivityNames(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.values(value)
    .map(slot => {
      if (!slot || typeof slot.name !== 'string') return '';
      const name = slot.name.trim();
      const detail = typeof slot.detail === 'string' ? slot.detail.trim() : '';
      return name ? `${name}${detail ? ` (${detail})` : ''}` : '';
    })
    .filter(Boolean);
}

async function sendPush(userId, settings, title, body, database, messaging) {
  const tokens = Object.keys(settings.tokens || {});
  if (!tokens.length) return;

  const siteUrl = typeof settings.siteUrl === 'string' && settings.siteUrl.startsWith('https://')
    ? settings.siteUrl
    : null;
  if (!siteUrl) {
    console.warn(`Skipping user ${userId}: missing HTTPS site URL.`);
    return;
  }

  let successCount = 0;
  const invalidTokens = [];

  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      data: {
        title,
        body: body.slice(0, 3500),
        url: siteUrl
      },
      webpush: {
        headers: { Urgency: 'high' },
        fcmOptions: { link: siteUrl }
      }
    });
    successCount += result.successCount;
    result.responses.forEach((response, index) => {
      if (!response.success && [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
      ].includes(response.error.code)) {
        invalidTokens.push(batch[index]);
      }
    });
  }

  if (invalidTokens.length) {
    const cleanup = {};
    invalidTokens.forEach(token => { cleanup[`tokens/${token}`] = null; });
    await database.ref(`${REMINDERS_PATH}/${userId}`).update(cleanup);
  }
  if (!successCount) {
    throw new Error(`Firebase rejected all "${title}" notifications for user ${userId}; will retry on the next run.`);
  }

  return successCount;
}

async function sendDueReminder(userId, settings, now, database, messaging) {
  if (!settings || settings.enabled !== true) return;

  const timeZone = typeof settings.timeZone === 'string' ? settings.timeZone : 'UTC';
  let local;
  try {
    local = getLocalDateTime(now, timeZone);
  } catch (error) {
    console.warn(`Skipping user ${userId}: invalid time zone "${timeZone}".`);
    return;
  }

  const deliveryErrors = [];
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.time || '')
      && local.time >= settings.time && settings.lastSentDate !== local.date) {
    try {
      const customSnapshot = await database
        .ref(`users/${userId}/workout_planner_data/logs/${local.date}/custom`)
        .once('value');
      const activityNames = getAddedActivityNames(customSnapshot.val());
      const body = activityNames.length
        ? `Your daily exercise workout starts now. Today's added activities: ${activityNames.join(', ')}.`
        : 'Your daily exercise workout starts now.';
      const successCount = await sendPush(userId, settings, 'Workout time', body, database, messaging);
      if (successCount) {
        await database.ref(`${REMINDERS_PATH}/${userId}/lastSentDate`).set(local.date);
        console.log(`Sent workout reminder for ${userId} (${local.date}); delivered to ${successCount} device(s).`);
      }
    } catch (error) {
      deliveryErrors.push(error.message);
    }
  }

  const customSnapshot = await database
    .ref(`users/${userId}/workout_planner_data/logs/${local.date}/custom`)
    .once('value');
  const customItems = customSnapshot.val();
  const sentHistoryRef = database.ref(`${REMINDERS_PATH}/${userId}/slotLastSent`);
  const sentHistorySnapshot = await sentHistoryRef.once('value');
  const sentHistory = sentHistorySnapshot.val();
  if (sentHistory && typeof sentHistory === 'object') {
    const expiredDates = {};
    Object.keys(sentHistory).forEach(date => {
      if (date !== local.date) expiredDates[date] = null;
    });
    if (Object.keys(expiredDates).length) await sentHistoryRef.update(expiredDates);
  }
  if (!customItems || typeof customItems !== 'object') return;

  for (const slot of Object.values(customItems)) {
    if (!slot || slot.reminderEnabled !== true
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.reminderTime || '')
        || typeof slot.reminderId !== 'string'
        || !/^[A-Za-z0-9_-]{1,80}$/.test(slot.reminderId)
        || local.time < slot.reminderTime) continue;

    const sentRef = database.ref(`${REMINDERS_PATH}/${userId}/slotLastSent/${local.date}/${slot.reminderId}`);
    const sentSnapshot = await sentRef.once('value');
    if (sentSnapshot.val() === true) continue;

    const name = typeof slot.name === 'string' && slot.name.trim() ? slot.name.trim() : 'Custom activity';
    const detail = typeof slot.detail === 'string' && slot.detail.trim() ? ` (${slot.detail.trim()})` : '';
    try {
      const successCount = await sendPush(
        userId,
        settings,
        'Activity reminder',
        `${name}${detail} starts now.`,
        database,
        messaging
      );
      if (successCount) {
        await sentRef.set(true);
        console.log(`Sent custom activity reminder for ${userId} (${local.date}); delivered to ${successCount} device(s).`);
      }
    } catch (error) {
      deliveryErrors.push(error.message);
    }
  }
  if (deliveryErrors.length) throw new Error(deliveryErrors.join('; '));
}

async function main() {
  const app = initializeFirebase();
  try {
    const database = getDatabase();
    const messaging = getMessaging();
    const snapshot = await database.ref(REMINDERS_PATH)
      .orderByChild('enabled')
      .equalTo(true)
      .once('value');
    if (!snapshot.exists()) {
      console.log('No enabled workout reminders.');
      return;
    }

    const now = new Date();
    const outcomes = [];
    snapshot.forEach(userSnapshot => {
      outcomes.push(
        sendDueReminder(userSnapshot.key, userSnapshot.val(), now, database, messaging)
          .catch(error => {
            console.error(`Failed to send reminder for ${userSnapshot.key}:`, error.message);
            return error;
          })
      );
    });
    const results = await Promise.all(outcomes);
    if (results.some(result => result instanceof Error)) {
      process.exitCode = 1;
    }
  } finally {
    await app.delete();
  }
}

main().catch(error => {
  console.error('Reminder workflow failed:', error.message);
  process.exitCode = 1;
});
