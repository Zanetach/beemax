import { MemoryStore } from "../../dist/index.js";

const [dbPath, profileId = "default"] = process.argv.slice(2);
if (!dbPath) throw new Error("Memory migration worker requires a database path");
const store = new MemoryStore(dbPath, profileId);
store.close();
process.stdout.write("ok");
