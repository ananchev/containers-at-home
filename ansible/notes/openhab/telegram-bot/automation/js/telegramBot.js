// Home Telegram bot (Thing telegram:telegramBot:home, conf/things/telegram.things, token NOT in git):
// the shared command menu.
//
// Pattern: one command per device or area, e.g. /ipad. The device script owns its command: it handles it
// on the messageEvent channel (a status card with sendTelegramQuery buttons, answered on callbackEvent)
// and registers it here by adding {"/cmd": "description"} to the JSON in cache.shared 'telegram.commands'.
// This script only answers /help and /start with that list, and points unknown commands to /help.
// Keep the BotFather menu (/setcommands) in sync: notes/openhab/telegram-bot/README.md
//
// Users of the bot: tabletBattery.js (/ipad), homeCalendar.js (reminders and digest, send only).
const { rules, triggers, log, actions, cache } = require('openhab');
const logger = log('telegramBot');

const BOT = 'telegram:telegramBot:home';
const OWN = { '/help': 'this list' };

function commands() {
  let cmds = {};
  try { cmds = JSON.parse(cache.shared.get('telegram.commands') || '{}'); } catch (e) { cmds = {}; }
  return Object.assign({}, cmds, OWN);
}

function send(text) {
  const bot = actions.thingActions('telegram', BOT);
  if (!bot) { logger.warn('Telegram Thing ' + BOT + ' missing; message was: ' + text); return; }
  if (bot.sendTelegram(text) !== true) logger.warn('Telegram send failed: ' + text);
}

rules.JSRule({
  name: 'Telegram bot: /help and unknown commands',
  description: 'Lists the commands registered by the device scripts',
  triggers: [triggers.ChannelEventTrigger(BOT + ':messageEvent')],
  execute: (event) => {
    let msg;
    try { msg = JSON.parse(String(event.receivedEvent)); } catch (e) { return; }
    const text = String(msg.text || '').trim();
    if (!text.startsWith('/')) return;
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
    const cmds = commands();
    if (cmd === '/help' || cmd === '/start') {
      send('🏠 Home bot commands\n' + Object.keys(cmds).sort()
        .map((c) => c + ' – ' + cmds[c]).join('\n'));
    } else if (!cmds[cmd]) {
      send('Unknown command ' + cmd + '. Send /help for the list.');
    }
  },
  id: 'telegram-bot-help',
});
