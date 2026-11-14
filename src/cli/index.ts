#!/usr/bin/env node
import { loadDotEnv } from '../env.js'
import { main } from './main.js'

// Credentials come from a gitignored `.env` in the folder the command is run from.
loadDotEnv()

process.exitCode = await main()
