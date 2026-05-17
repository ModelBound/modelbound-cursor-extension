# VS Code Extension Quickstart

## What's in the folder

- `package.json` - Extension manifest declaring commands, settings, and metadata.
- `src/extension.ts` - Main extension entry point handling activation, file watching, and commands.
- `src/mcpServer.ts` - Model Context Protocol server implementation for AI agent integration.
- `.vscode/launch.json` - Debug configuration for launching the Extension Development Host.
- `tsconfig.json` - TypeScript compiler configuration.

## Get up and running straight away

1. Run `npm install` in the terminal to install dependencies.
2. Press `F5` to open a new window with your extension loaded.
3. Set your API key in settings: `modelbound.apiKey`.
4. The extension activates on startup and begins watching `.modelbound/` for changes.

## Make changes

- Edit files in `src/` and recompile with `npm run compile`.
- Reload the Extension Development Host window (`Ctrl+R` / `Cmd+R`) to pick up changes.
- Use `npm run watch` for automatic recompilation during development.

## Run tests

- Currently no test suite is configured. Contributions welcome!

## Explore the API

- Open `node_modules/@types/vscode/index.d.ts` for the full VS Code API reference.
- Use IntelliSense (`Ctrl+Space`) to explore available APIs in your source files.
