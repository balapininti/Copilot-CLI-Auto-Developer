#!/usr/bin/env node
// Entry point for the autodev CLI. Skills and PowerShell wrappers call this file.
import { main } from '../src/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
