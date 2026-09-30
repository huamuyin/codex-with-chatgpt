# Opt-in Local CDP Transport (Experimental)

This transport is an explicit per-workspace alternative for normal ChatGPT web
UI control messages. It does not replace the default legacy transport, start a
browser, pair a connector, call a ChatGPT API, or collect cookies, tokens, or
browser storage. The configured browser must already be running with a local
CDP endpoint. Only loopback endpoints are accepted.

## Configure

Configure machine-wide browser metadata once, then opt in only the selected
workspace:

```powershell
c2c runtime config --set --cdp-endpoint http://127.0.0.1:9222 --browser edge --profile-identity "C2C Reviewer" --lifecycle external --json
c2c transport set --mode local-cdp -w D:\Repos\example --json
c2c runtime status -w D:\Repos\example --probe --json
```

`runtime status --probe` attaches, reports visible-page counts, and disconnects.
It does not navigate or send a message. Machine configuration alone never opts
workspaces in; `c2c transport get` reports each workspace's independent mode.

## Persist local execution and deliver

Record the conversation and local checkpoint with an exact task, iteration,
control ID, and saved chat URL. `EXECUTED_LOCAL` means local work is recorded;
it does not assert that a message was sent:

```powershell
c2c session set -w D:\Repos\example --url https://chatgpt.com/c/<chat-id> --mode long-chat --task TASK_ID --iteration 1 --protocol-state EXECUTED_LOCAL --control-id CONTROL_ID --waiting-for none --goal "..." --next-step "..."
c2c control-resume -w D:\Repos\example --message-file D:\ProjectData\example\control.txt --json
```

The message file path must be absolute and the file is limited to 64 KiB. The
message must contain exact `STATE`, `MISSION_ID`, `ROUND`, and `CONTROL_ID`
lines matching the saved checkpoint. The sender uses the visible composer and send control,
then waits for an assistant reply with exact identity lines and a stable
completed response.

Before typing, the sender checks visible conversation history. It writes a
workspace-scoped delivery intent containing identity, timestamp, and request
hash, but never the message body. If submission becomes uncertain, a later
`control-resume` checks the same visible chat and journal. It waits on a visible
request without resending; it only submits when the exact control is absent.
Missing delivery intent, ambiguous history, mismatched response IDs, or timeout
fail closed and leave the checkpoint at `EXECUTED_LOCAL`.

A validated `BrowserReceipt` binds workspace, task, iteration, control ID, chat
URL, request and response times, and payload hashes. Only after persistence
does the checkpoint advance to `EXECUTED_SENT` / `GPT_REVIEW`.

## Inspect

```powershell
c2c receipt list -w D:\Repos\example --json
c2c receipt validate -w D:\Repos\example --task TASK_ID --round 1 --control-id CONTROL_ID --chat-url https://chatgpt.com/c/<chat-id> --json
```

Receipt commands omit response text. The attach-only adapter exposes visible
page metadata and normal UI locators only; it provides no cookie, token,
storage, or network inspection methods. A legacy workspace remains on its
legacy protocol and is never attached by `control-resume`.
