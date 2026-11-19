# Home Telegram bot

openHAB Telegram binding, Thing `telegram:telegramBot:home` in `conf/things/telegram.things`
(holds the bot token and chat id: **not in git**, template
`../tablet-battery/things/telegram.things.example`).

## Commands: one per device or area

| Command | Owner | What it does |
|---|---|---|
| `/ipad` | `tablet-battery/automation/js/tabletBattery.js` | Dashboard iPad status card with buttons (Refresh, Enable/Disable control) |
| `/help` | `automation/js/telegramBot.js` | lists the registered commands |

How a device script adds its command:

1. Handle it on the `messageEvent` channel: `triggers.ChannelEventTrigger('telegram:telegramBot:home:messageEvent')`,
   with `JSON.parse(event.receivedEvent).text`. Don't trigger on the `lastMessageText` item: an update
   trigger gets `event.receivedState`, and repeating the same command does not change the item.
2. Actions go on inline buttons: `sendTelegramQuery(text, replyId, ...buttons)`. The press arrives on
   `callbackEvent` (`{reply_id, text, ...}`). Always close it with `sendTelegramAnswer(replyId, textOrNull)`.
3. Register it for `/help`: add `{"/cmd": "description"}` to the JSON in `cache.shared` key `telegram.commands`.
4. Add it to the BotFather menu, so it shows when you type `/`.

Command names: lowercase letters, digits and `_`, max 32 characters (Telegram rule).

Gotcha: in JS, `sendTelegram(text)` with a single argument sends the text as is. Don't escape `%`.
That escaping is only for the DSL/format overload `sendTelegram(format, args...)`.

## BotFather menu

In Telegram, open @BotFather, send `/setcommands`, pick the bot, then send:

```
ipad - Dashboard iPad: battery, charger plug, control
help - List the commands
```

## Gotcha: buttons do nothing

Telegram remembers the last `allowed_updates` filter any client set for the bot. The old calibration
bot (`calib.py`, retired 2026-11-19) set it to messages only, so button presses (`callback_query`)
never reached openHAB, and no `callbackEvent` showed up in events.log. The binding doesn't override it.
Check: `getWebhookInfo` → `allowed_updates`. Fix (done 2026-11-19): call `getUpdates` once with
`timeout=0&limit=1&allowed_updates=["message","callback_query"]` and no `offset`, so nothing gets
marked as read. Read the token from `telegram.things` into a shell variable, never print it.
