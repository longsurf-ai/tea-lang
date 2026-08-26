#!/usr/bin/env -S node --import tsx
// Purpose: Executable shell for the Tea CLI.

import {runCli} from './cli/cli';

process.exitCode = await runCli(process.argv);
