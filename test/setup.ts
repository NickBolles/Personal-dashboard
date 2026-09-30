import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Each test file gets an isolated data dir so the secret key file and DB never collide.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
process.env.JARVIS_DATA_DIR = dir;
process.env.JARVIS_DB_PATH = ":memory:";
process.env.JARVIS_SETUP_CODE = "TESTCODE";
process.env.JARVIS_DISABLE_WORKER = "1";
