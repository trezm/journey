#!/usr/bin/env node
// Source-tree entry point. The downloadable public/git-sync.mjs is self-contained.
import { main } from '../public/git-sync.mjs';
main().catch(() => { console.error('Cannot start Git sync. Check your connection file and run --help for usage.'); process.exitCode = 1; });
