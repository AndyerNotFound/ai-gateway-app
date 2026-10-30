# AI Gateway APP
The client for ai-gateway, you can run the **ai-gateway** in this Application or connect to your **Termux** (also **ZeroTermux**)
It supports you to edit your channels or configurations. The default port to access is *16384*. If connection was failed, please re*boot* your back-end process. 
It also supports **Material You** theme. You can change the color anytime.
It can also filter some **privacy contents** like API-Keys\IDcards\Passwords and so on. 
And it can **route** your requests automatically between different channels. 
Holy shit I don't know How to continue so it's short
☝️🤓
## 0.5.0

- **Built-in gateway**: run ai-gateway-AI on the phone itself. A foreground service (separate `:node` process) hosts the bundled Node 18.20.4 runtime, so the phone can serve `/v1` without Termux. Battery-optimization whitelist is one tap away; nothing auto-starts after reboot.
- **File extractor**: open a `requests-<instance>.jsonl` (or a JSON array) with the system file picker and read the request/response bodies of every recorded call.
- **Accounts removed**: user registration, password login and the user-management pages are gone from both the app and the server. API key cards stay exactly where they were.
- **Smaller APK**: release builds now run R8 and resource shrinking.

## 0.6.0

- New launcher icon: the three-L mark, white on black (adaptive icon, 108dp foreground).

## 0.5.3

- Second factor: the TOTP secret no longer disappears right after "Enable TOTP". It stays on screen (tap to copy), the otpauth link is shown too, and the copy stored in the connection profile is shown when you come back to the page.

## 0.5.2

- Built-in gateway: repeated start, stop→start, and system restarts can no longer call the Node runtime twice, leave the UI stuck at "starting", or bring a stopped gateway back to life.
- Built-in gateway: a dedicated "Local gateway" profile is created instead of overwriting the remote server address.
- Web Token rotation: only the current token may rotate. The 5-minute old-token grace is gone — a revoked token stops working immediately.
