import { writeFile } from "node:fs/promises";

process.stdout.write("partial-evidence\n");
process.on("SIGTERM", () => {});
if (process.argv[2]) await writeFile(process.argv[2], "ready\n");
setInterval(() => {}, 1_000);
