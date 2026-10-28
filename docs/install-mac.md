# Install on a Mac

This guide is for writers who use Scrivener and want an AI assistant to work with their manuscript.
You do not need to know how to code. It takes about five minutes.

## Pick how to install

|                                              | Draftbridge app                | Free command-line setup              |
| -------------------------------------------- | ------------------------------ | ------------------------------------ |
| Cost                                         | One-time purchase              | Free                                 |
| Setup                                        | Open the app and click Connect | Paste one line into Terminal (below) |
| Node.js                                      | Included                       | Installed for you if missing         |
| Repairs a connection after an AI app updates | One click                      | Run the line again                   |

Both do the same job and connect the same server. The server, the setup tool and the Claude Desktop
extension are open source and free. The app is the ready-made build with a guided screen, and buying
it supports the project.

## Get the Draftbridge app

Buy it for $4.99 at
[buy.stripe.com/14A8wHbm64Y0dR8fFdc7u01](https://buy.stripe.com/14A8wHbm64Y0dR8fFdc7u01). Your
license key appears on the page after checkout and is emailed to you, with a link to download the
app. It works on up to 3 of your Macs. If you already have the key,
[download the app](https://updates.writerslogic.com/draftbridge/Draftbridge-latest.dmg), open it,
and paste the key.

## What you need

- A Mac with Scrivener 3
- An AI app that supports MCP: Claude Desktop, BoltAI, Raycast, LM Studio, Cursor, or VS Code
- An account or key for that app's AI service. Draftbridge does not include one.

## Fastest: the Claude Desktop extension

If you use **Claude Desktop**, this is the simplest route and needs no Terminal.

1. Download `scrivener-mcp-<version>-macos-arm64.mcpb` from the
   [latest release](https://github.com/writerslogic/scrivener-mcp/releases/latest).
2. Double-click the file. Claude Desktop opens an install window.
3. Review the details and click **Install**.

The extension carries its own copy of everything it needs, so it works on a Mac with nothing else
installed. It needs an Apple silicon Mac. For other AI apps, or an Intel Mac, use the installer
below.

## Step 1: Run the installer

Open **Terminal** (press Cmd+Space, type Terminal, press Return) and paste this line:

```bash
curl -fsSL https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/scripts/bootstrap-mac.sh | sh
```

What it does:

1. Looks for Node.js, the free software Draftbridge runs on. If your Mac has a recent version, it
   uses it.
2. If not, it asks before downloading the official Node.js into a private folder,
   `~/.scrivener-mcp/node`. It checks the download's SHA-256 checksum, needs no password, and
   changes nothing else on your Mac.
3. Finds the AI apps you have installed and adds Draftbridge to each one.
4. Starts the server once to make sure it works, and tells you which apps to restart.

Your existing settings in those apps are kept. Before changing a settings file, the installer saves
a dated backup beside it.

## Step 2: Restart your AI app

Quit the app completely (Cmd+Q), then open it again. MCP servers load only when an app starts.

## Step 3: Try a safe sample

Run `npx --package scrivener-mcp scrivener-setup --demo` for an isolated local analysis and edit
preview before opening your own manuscript. It changes no client configuration. See
[the first-session guide](getting-started.md#first-successful-editorial-session) for the public
server capabilities and provider/privacy choices.

## Open your project

Open your AI app and ask:

> Open my Scrivener project and tell me how many words are in each chapter.

The first time, it will ask which project. Projects are `.scriv` packages. If you keep them in
iCloud or Dropbox, say so and it will look there.

## If something goes wrong

Run the checker. It changes nothing and reports each app's state:

```bash
curl -fsSL https://raw.githubusercontent.com/writerslogic/scrivener-mcp/main/scripts/bootstrap-mac.sh | sh -s -- --check
```

| You see                          | What it means                             | What to do                                                                                 |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `outdated`                       | An older Draftbridge entry is in the app  | Run the installer again. It repairs it.                                                    |
| `unreadable`                     | The app's settings file is not valid JSON | Open the file it names, fix or move it, then run the installer again. Nothing was changed. |
| `Start-up test FAILED`           | The server could not start                | See [Troubleshooting](./troubleshooting.md) and include the message when you ask for help. |
| The app shows no Scrivener tools | The app was not restarted                 | Quit it with Cmd+Q and reopen it.                                                          |

To remove Draftbridge, run the installer with `-s -- --remove`. To delete the private Node.js,
delete the folder `~/.scrivener-mcp/node`.

## Keeping your manuscript safe

- Draftbridge refuses to write to a project while Scrivener has it open, because Scrivener would
  overwrite the changes. Close the project in Scrivener first.
- Edits keep your formatting, styles, footnotes, and images. When an edit would lose inline styling,
  a Scrivener snapshot is taken first so you can roll back from Scrivener's own Snapshots panel.
- You can ask the assistant to take a snapshot before any big revision.
- Keep your normal Scrivener backups on. Nothing here replaces them.

## Other ways to set up

- **Advanced users:** `npx --package scrivener-mcp scrivener-setup` does the same thing from a
  terminal that already has Node.js. See [MCP Client Setup](./CLIENT_SETUP.md) for per-app details
  and one-click install links.
- **Manual:** copy the JSON from `npx --package scrivener-mcp scrivener-setup --print` into your
  app's MCP settings.
