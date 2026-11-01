# PersonalPC — PocketDesk

Run Claude Code on your laptop and control it from your own phone, even with the lid closed.
It uses **no** claude.ai Remote Control. Only your paired devices can get in.

```
Phone (PocketDesk app) ──Tailscale, your private network──► Laptop: PocketDesk (127.0.0.1:8765)
                                                              ├─ Claude Code on the account you pick per session
                                                              └─ files on the whole C: drive (key/login files blocked)
```

## Already done on the laptop

- PocketDesk is installed in `pocketdesk/`, runs at http://127.0.0.1:8765, and starts automatically when you log in (Startup shortcut).
- **Default account is yotayade@gmail.com** (`main` profile). When you start a session you can pick any signed-in account. That session only runs if Claude really is signed in as the account you picked.
- Tailscale is installed and connected; the phone is paired.
- Remote Control in the Claude desktop app is turned off for new sessions.

## Your steps (about 10 minutes, once)

**1. Keep running with the lid closed.** Open PowerShell as Administrator and run:

```powershell
C:\Users\banka\Projects\PersonalPC\scripts\1-lid-keep-running.ps1
```

This only applies while plugged in. Add `-AlsoOnBattery` if you really want it on battery too. To undo it, run `scripts\undo-lid.ps1`.

**2. Connect Tailscale and share PocketDesk.** In normal PowerShell, run:

```powershell
C:\Users\banka\Projects\PersonalPC\scripts\3-tailscale.ps1
```

Sign in with your **personal** account when the browser opens. The script then prints your phone address, which looks like `https://swastik.tailXXXX.ts.net`.
If Tailscale says HTTPS certificates are off, open the link it prints, click **Enable**, and run the script again.

**3. On your phone:**
1. Install the **Tailscale** app and sign in with the **same** account.
2. Open the phone address from step 2 in Chrome or Safari.
3. On the laptop, open http://127.0.0.1:8765, go to **Setup**, and press **Make pairing code**. Type that code on the phone.
4. In the browser menu, choose **Add to Home screen**. On iPhone this is Share → Add to Home Screen.
5. Open the app from the home screen, go to **Laptop**, and press **Turn on notifications**.

**4. Stop Windows Update from restarting the laptop while you're out.** Go to Settings → Windows Update → Advanced options → Active hours, and set them to cover your day.

## Using it

- **Start long work from PocketDesk, not from the desktop app**, so your phone can follow it. Use the **Claude** tab → **+ New**, pick a folder, and type the task. This works on the laptop too.
- When Claude needs permission, asks a question, or has a plan for you, you get a notification. Answer it on the phone.
- A session pauses after 20 idle minutes to save memory. Send a message and it continues where it left off.
- **New session:** pick the folder, the **account**, the **model** (the same list as the desktop app: Default, Opus, Fable, Sonnet, Haiku) and the **effort** (Low → Max).
- **Usage** tab: each account's 5-hour and weekly limits, with reset times. Checking sends no message, so it uses none of your limit.
- **From PC** tab (⇄): every Claude Code chat on the laptop (desktop app and terminal, all accounts), newest first. Open one to read the whole chat, then press **📱 Continue this chat on the phone**. Pick the account it continues on: the accounts share one chat history, so PocketDesk can only guess which one ran it. Desktop-app chats ran as yotayade@gmail.com, which PocketDesk has no login for, so they continue on one of your other accounts.
  - **"switch to phone"**: once it's turned on (laptop → Setup → card 4 → **Turn on for all accounts**), typing `switch to phone` (or `move to mobile`, `continue on phone`…) in any laptop chat moves that chat to PocketDesk and buzzes the phone. That message is not sent to Claude. It works in chats started after turning it on. To come back to the laptop, run `/resume` there (or `claude --resume <id>`). Don't type in both places at once.
  - A paused phone session has a **👤 Account** button to continue it on another account.
- **Files** tab: view, edit, upload and download anywhere on the C: drive (choose **C: drive** at the top). Private keys and Claude login files stay blocked.
  - **🖼 Photos & videos**: on the Files home there are shortcuts (Pictures, Screenshots, Camera Roll, Videos, Downloads, Desktop), and **🖼 Gallery** opens any folder as a grid, newest first. Tap a photo for full screen; swipe or use ‹ › to move between them. Videos play and seek in the page. Formats the phone can't play (HEIC, AVI, WMV…) show a preview with a download button. Thumbnails are made with ffmpeg and kept in `pocketdesk/data/thumbs` (deleted after 30 days).
- **Project** tab (or **🛠 Run / Git** in Files): pick a project folder, then:
  - **Type a command**: any one-line command, run in that folder in `cmd` or PowerShell (pick at the right). Recent ones are kept as chips. If the command asks something ("Proceed? (y/N)"), type the answer in the box at the bottom of its screen. Each typed command is written to the activity log. To turn typing off, set `"allowCustomCommands": false` in the config.
  - **Run**: buttons for the folder's own `package.json` scripts (`dev`, `test`, `build`…), `npm install`, and any `quickCommands` from the config. The output shows live, and you get a notification when a long command finishes or one fails. **Stop** ends the command and everything it started.
  - **Open a dev server on the phone**: once `npm run dev` prints its port, press **📱 Open port … on phone**. Tailscale shares it at `https://swastik.tailf52557.ts.net:<port+10000>` (port 3000 becomes 13000), reachable only from your own devices. Sharing ends by itself when the dev server stops.
  - **Git**: branch, changed files, tap a file for its diff, tick to stage, commit ("staged" or "everything"), pull (fast-forward only), and push (asks first). Discard, reset, stash and force-push are left out on purpose. Folders without their own repo (e.g. `swastik-java`, `PersonalPC`) show an error because your home folder's `.git` is broken.
- **Laptop** tab: battery, temperature, memory, disk, plus lock and sleep buttons. Remember the phone **cannot wake** a sleeping laptop.
  - **Alerts on the phone**: battery low (default 20%, plus a critical alert at 10%), charger pulled out, too hot (default 90°C), internet back after an outage, laptop woke up / PocketDesk restarted. This laptop's sensor reads about 28°C, a board sensor, so take temperature alerts as rough.
  - **Security**: a **PIN lock**. After the idle time you pick (default 15 min) the phone asks for the PIN. 5 wrong tries block it for 15 minutes; 10 unpair it. The laptop itself never asks.
  - **Activity log**: everything done through PocketDesk (files saved, commands run, commits, pushes, Claude sessions, PIN tries, alerts) with time and device. It is kept in `pocketdesk/data/activity.jsonl`.

## Phone remote extras

- **Allow / Deny right on the notification.** When Claude asks "Allow Bash?", the phone alert has Allow and Deny buttons, so you don't need to open the app. Each button works once, and only for that one request. If PocketDesk is PIN-locked, tapping a button opens the app for the PIN. To skip that, turn on Laptop → Security → "Allow / Deny on notifications work while PocketDesk is locked".
- **Done / stuck alerts** (Laptop → Alerts → Claude):
  - A laptop chat (desktop app or terminal) finished.
  - A laptop chat has been sitting on one step for a few minutes. Usually it is waiting for you to approve something on the laptop.
  - A phone session made no progress for a while.
- **Saved prompts** (⚡): a row of buttons on the Claude tab. Tap one to start a new session with that prompt, in its saved folder if it has one. In an open chat, ⚡ puts the prompt in the message box. Edit them at Claude → Saved prompts → Edit, or press "Save as a button" on the New session screen.
- **📷 Photos to Claude:** in a chat or on New session, add up to 4 photos from the camera or gallery. They are shrunk on the phone first, then shown in the chat.
- **Laptop tab → Control the laptop:**
  - **See the screen:** a live view only; it never clicks or types. It asks for the PIN, then works for 10 minutes. It shows nothing when the lid is closed with no monitor, or when Windows is locked.
  - **Clipboard:** get what is copied on the laptop (text or a picture), or put text on the laptop clipboard.
  - **Send to laptop:** files and photos go to `Downloads\From phone`. A link can open in the laptop browser, go to the laptop clipboard, be added to `Notes from phone.md`, or be sent to Claude. In any phone app, **Share → PocketDesk** lands on this screen. That needs PocketDesk on the home screen; Chrome may take a day to show it, or you can remove and re-add the app.
  - **Find my laptop:** an alarm at full volume for 1 minute (your volume comes back afterwards), plus its Wi-Fi name, addresses and battery.
- **Restart / Shut down** (Laptop → Power): the phone asks for the PIN again. Each waits 1 minute and can be cancelled. After a restart, PocketDesk comes back only once someone signs in to Windows. After a shutdown, the phone cannot turn the laptop on.
- **Login alerts:** you get a notification when:
  - a new device pairs;
  - an unpaired device reaches the pairing page (with its Tailscale name);
  - a paired phone's login is used from a different Tailscale device, which would mean a copied cookie.
- **🚨 Panic button** (Laptop → Security, also on the PIN screen): stops every PocketDesk Claude session and command, stops dev-server sharing, unpairs **every** device (including the one you pressed it on) and locks the laptop screen. Desktop-app chats keep running. Afterwards, pair again with a new code.

## 🧳 Travel mode (lid closed, in the bag, 30–90 min)

**Laptop** tab → **🧳 Travel mode** (on the phone or the laptop). Claude keeps working while everything else stops making heat.

- **Before you go (by hand):** press **Fn + Q** until the power-button light is **blue** (Quiet mode: the biggest help). Take the charger out. Turn the keyboard light off with **Fn + Space**. Put the laptop **upright** in the sleeve, not in the pocket against your back, and leave the zip open a little near its back edge. Do this once: Lenovo Vantage → GPU Working Mode → **Hybrid-Auto**.
- **What it does:**
  - **Pauses** the apps you tick. Chrome and Dynamic Island are ticked by default. Paused apps stay open, make zero heat, and come back exactly as they were.
  - **Keeps running:** PocketDesk, the Claude desktop app, Claude in terminals and editors (with the terminal or editor hosting it), everything Claude started, Tailscale and Windows.
  - **Power plan:** turbo off, CPU capped (Coolest 60% / 1.6 GHz, or Cool 85% / 2.2 GHz), CPU energy preference on full saving, Windows energy saver on, and lid "do nothing" for the trip only.
  - **Efficiency cores:** Claude and what it runs go onto the 4 efficiency cores, in Windows efficiency mode.
  - **Bluetooth** is off for the trip.
  - **Light work:** Claude is told to avoid builds, installs, full test runs and Docker. Heavy **Project**-tab commands ask to wait and run automatically when the trip ends.
- **How it ends:**
  - **Timer:** a phone alert 5 minutes before the end. When time is up, the laptop sleeps (or hibernates). If Claude is still working, you get a 10-minute grace and a **+15 min** button.
  - **Sleep when done** (on by default): 3 quiet minutes after Claude finishes, you get a 1-minute warning (with **Stay awake**), then it sleeps.
  - **Battery dropping faster than 1%/min:** a phone alert, and the CPU switches to Coolest.
  - **Opening the lid** after it slept, **plugging in the charger**, or **End Travel mode** brings everything back: apps resume, cores and power settings go back to their old values, Bluetooth comes back on, and waiting commands start.
- If PocketDesk restarts mid-trip, it carries on. After a laptop restart it only puts the power plan back. State is kept in `pocketdesk/data/travel.json`.
- Laptop chats (desktop app or terminal) get the "keep work light" note only once the "switch to phone" hook is turned on (Setup → card 4). Phone sessions always get it.
- Needs no admin: it only changes your own power plan and your own programs.

## Safety rules

- Outside Travel mode, don't put the laptop in a bag while it's running. Leave it at home, plugged in, on a hard surface.
- To remove a lost phone, go to Setup → Paired devices → Remove on the laptop. It loses access immediately. **Lock all phones now** makes every phone type the PIN again.
- Setup → **Only allow my own Tailscale login**: devices someone else shares into your tailnet are refused, even with a pairing code.
- PocketDesk only listens on `127.0.0.1`. The only way in from outside is Tailscale, on your own account.

## Settings: `pocketdesk/config.json`

| Key | Meaning |
|---|---|
| `allDrives` | `true` = every drive is reachable (on now). Set `false` to limit access to `roots` only |
| `roots` | Shortcut folders shown first. Add more, e.g. `{ "name": "Desktop", "path": "C:\\Users\\banka\\Desktop\\Cashout" }` |
| `deny` | File names that are always blocked |
| `maxLiveSessions` | How many Claude sessions can run at once |
| `idleSessionMinutes` | How long before an idle session pauses |
| `allowPowerActions` | Turns the lock and sleep buttons on or off |
| `allowedTailscaleUsers` | Optional: only these Tailscale logins, e.g. `["you@gmail.com"]` (or use the switch in Setup) |
| `allowCustomCommands` | `false` turns off the **Type a command** box (on by default) |
| `quickCommands` | Extra fixed buttons for the Project tab, e.g. `[{ "name": "Python tests", "cmd": "python -m pytest" }]`. They run in the chosen folder. Only someone at the laptop can add them |

After changing the config, restart PocketDesk: stop the `node` process running `pocketdesk\server.js`, then run `scripts\start-phone-access.ps1`.

## For developers

```powershell
cd pocketdesk
npm test        # 58 tests (17 in travel.test.js, 13 in features.test.js): path safety, pairing, account checks, sessions, usage, commands, typed commands, git, share, PIN lock, alerts, video ranges, thumbnails, laptop chats, "switch to phone" hook + installer
```

Logs are in `pocketdesk/logs/`. App data (devices, sessions, push keys) is in `pocketdesk/data/`; don't share that folder.
