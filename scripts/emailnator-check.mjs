#!/usr/bin/env node
/**
 * Diagnostic for the emailnator provider (no vosko calls, no proxies).
 *
 *   node scripts/emailnator-check.mjs [waitSeconds]
 *
 * Prints a freshly issued address, then waits for a mail and shows the code it
 * extracted. Send the message yourself (or trigger a vosko login for it) while
 * it waits. CAPTURE-nothing — this only reads the public inbox.
 */

import * as emailnator from './lib/emailnator.mjs';

const waitSeconds = Math.max(10, Math.min(600, Number(process.argv[2] || 120)));

const { email, type, typeId } = await emailnator.generateAddress();
console.log(`address : ${email}`);
console.log(`type    : ${type} (${typeId})`);
console.log(`inbox   : https://www.emailnator.com/inbox#${email}`);
console.log(`waiting ${waitSeconds}s for a code…`);

try {
  const otp = await emailnator.waitForCode(email, { waitSeconds });
  console.log('code    :', otp.code);
  console.log('from    :', otp.sender);
  console.log('subject :', otp.subject);
  console.log('message :', otp.message_id);
  console.log(JSON.stringify(otp, null, 2));
} catch (err) {
  console.log(`no code: ${err.message}`);
  try {
    const { messages, count } = await emailnator.listMessages(email);
    console.log(`messages now (${count}):`);
    for (const m of messages) console.log(`- ${m.from || '?'} | ${m.subject || '?'} | ${m.time_ago || m.time || ''}`);
  } catch (inner) {
    console.log(`could not read the inbox: ${inner.message}`);
  }
  process.exitCode = 1;
}
