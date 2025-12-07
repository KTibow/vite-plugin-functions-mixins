#!/usr/bin/env node
import { processBuildFolder } from "./index";

await processBuildFolder({ dir: process.argv[2] });
