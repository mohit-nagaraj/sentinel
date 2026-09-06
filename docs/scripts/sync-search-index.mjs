import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("public/_pagefind");
const destination = resolve("out/_pagefind");

await rm(destination, { force: true, recursive: true });
await mkdir(resolve("out"), { recursive: true });
await cp(source, destination, { recursive: true });
