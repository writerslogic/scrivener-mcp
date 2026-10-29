# Frequently asked questions

## What is Draftbridge for Scrivener?

A Mac app that connects an AI app, such as Claude Desktop, BoltAI, or Raycast, to your Scrivener projects in one click, so it can read and work with them. It runs on your Mac. Your manuscript is not uploaded anywhere by Draftbridge.

## What can I do with Scrivener MCP?

The [capability map](../assets/infographics/capability-map.png) covers manuscript management, search,
AI writing, analysis, story memory, relationships, editorial workflows and publishing.

## Is it free?

The app is a small one-time purchase. The server it uses, the command-line setup tool, and the Claude Desktop extension are open source and free, and they do the same job with more manual steps. See [Install on a Mac](./install-mac.md). Looking around the app, testing the connection, and disconnecting are always free. If a license is ever refunded or lapses, the apps you already connected keep working.

## How do I move my license to a new Mac?

Open Draftbridge, then Settings, then License, and choose **Deactivate**. That frees the seat. Then enter your key on the new Mac.

## Does the AI see my whole book?

Only what you ask about. The AI app reads the parts it needs to answer you, and that text is sent to that app's AI service under its own privacy terms. Check those terms before using unpublished work. Using an AI app that runs locally, such as LM Studio, keeps everything on your Mac.

## Do I need an account?

Yes, with the AI app you choose. Draftbridge itself needs no account.

## Will it change my manuscript without asking?

It only edits when you ask it to. It refuses to write while Scrivener has the project open, takes a snapshot before risky edits, and keeps your formatting. See [Install on a Mac](./install-mac.md) for details.

## Which Macs are supported?

The app needs macOS 14 or later on an Apple silicon Mac. On an Intel Mac, use the one-line installer in [Install on a Mac](./install-mac.md) instead.

## Which AI apps work?

Claude Desktop, Claude Code, Cursor, VS Code, LM Studio, BoltAI, and Raycast. ChatGPT's desktop app does not run local connectors like this one.

## The AI app does not show any Scrivener tools

Quit the app completely (Cmd+Q) and reopen it. If it still does not appear, open Draftbridge and press **Test connection**, then see [Troubleshooting](./troubleshooting.md).

## Project memory cannot be loaded

Existing memory files that are unreadable or invalid are left unchanged. Check
file permissions first. If `.ai-memory/project-memory.json` is damaged, stop the
server, preserve a copy of that file, and restore a known-good
`.ai-memory/backup-YYYY-MM-DD.json` as `project-memory.json` before restarting.
These files are inside the Scrivener project package.

## How do I remove it?

In the app, click the menu beside each connected app and choose **Disconnect**, then delete the app. Your Scrivener projects and your other AI settings are not touched.

## Is it open source?

The server, the command-line setup tool and the Claude Desktop extension are, under the AGPL-3.0 license, at [github.com/writerslogic/scrivener-mcp](https://github.com/writerslogic/scrivener-mcp). A commercial license is available; see `COMMERCIAL_LICENSE.md`. The Draftbridge Mac app itself is closed source.
