# pi-memory-system

Persistent memory for the Pi coding agent. The extension pulls project facts, decisions, and user preferences out of a session, keeps them as layered records, and recalls the relevant ones on later turns.

Website: [pi-memory-system](https://pi-memory-system.yinwenyuan28.workers.dev/) · [Mirror](https://pi-memory.com)  
Contact: [email@pi-memory.com](mailto:email@pi-memory.com)

Chinese documentation: [README-cn.md](README-cn.md)

## What it does

- Extracts memories from conversations and retrieves them on demand.
- Organizes memory in three layers: L1 atomic records, L2 scenario blocks, L3 user profile.
- Tracks to-do memories with **done**, **drop**, and **reopen** states.
- Ships a local viewer for inspecting memory data, the processing queue, and profile drafts.

## Requirements

- **Windows only.** Stopping sub-agents relies on Windows process-tree semantics, and project ownership checks use drive-letter path rules.
- **Node.js >= 22.13.0.**
- Tested with pi 0.84.2, pi-coding-agent 0.83.0, and pi-ai 0.74.2. Other versions are not yet promised to work.

## Install

From npm:

    pi install npm:pi-memory-system

Then run **/reload** in Pi, or restart Pi.

If you previously placed the extension manually at **~/.pi/agent/extensions/memory-system**, move that directory out of `extensions` before installing the package. Pi scans both directory extensions and package config; keeping both causes duplicate loading and duplicate tool registration.

To install from a local checkout, pass the repository directory:

    pi install ./path/to/pi-memory-system

**Do not pass a .tgz file to `pi install`.** To test a tarball, extract it first and install the extracted directory.

## First run

After install and reload, the extension starts the basic memory pipeline automatically. Vector search is off by default and stays off unless you configure an embedding service.

Commands:

- **/my-memory:model** — configure the background LLM and embedding service, and explicitly enable or disable vectorization.
- **/my-memory:model:peek** — read-only view of the current profile's model, vectorization setting, and local vector state.
- **/my-memory:l1:task list** — list open task memories; update status with **done**, **drop**, or **reopen** plus the record ID.
- **/my-memory:profile list** — list profiles; switch with **/my-memory:profile switch &lt;name&gt;**.

The config file is created on first run under the active Pi profile:

    <agentDir>/profiles/<profile>/memoryDB/config/application-propertis.json

Vectorization requires a compatible embedding service. The Pi extension UI does not mask API keys while you type them, and the key is stored in the profile config file. Restart Pi after changing embedding settings.

## Data and viewer

Memory data is stored locally per profile. When you enable the background LLM or vectorization, processing uses the model or embedding service you configured.

Start the viewer from a source checkout:

    npm run viewer

The viewer listens on localhost by default, but it can read memories and perform some writes. LAN mode has no authentication; use it only on a trusted network. See the [viewer guide](docs/viewer-guide.md) for full instructions and security boundaries.

## UI language

Command descriptions, prompts, status bar, and reports support English and Chinese. The default is **automatic, following the system locale**: English systems get English, Chinese systems get Chinese.

    /my-memory:language            # show current language
    /my-memory:language en         # switch to English
    /my-memory:language zh-CN      # switch to Chinese
    /my-memory:language auto       # back to auto-detection

Run **/reload** once after switching: command descriptions and already-rendered cards refresh on the next load, while the status bar updates immediately. You can also set `language.locale` in `<profile>/memoryDB/config/application-propertis.json`.

To add a language, drop a `<lang>.json` file into `i18n/locales/` — no code changes needed. See the [i18n guide](i18n/README.md).

## Known limitations

- Vectorization is off by default; enabling it requires an embedding service. Do not change the embedding dimension when vector data already exists.
- Switching profiles updates **memorySystem.activeProfile** in Pi's **settings.json**.
- The extension does not write sub-agent files into **~/.pi/agent/agents/**; sub-agent definitions ship with the extension.

## Development and release

See the [development guide](docs/development.md) for dev dependencies, checks, viewer gates, and npm publishing. For design details, see the [architecture notes](%E8%AE%B0%E5%BF%86%E7%B3%BB%E7%BB%9F%E6%9E%B6%E6%9E%84%E8%AF%B4%E6%98%8E.md) (Chinese).

## License

MIT
