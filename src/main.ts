import "reflect-metadata";
import { run } from "./bootstrap";
import { loadEnv } from "./core/config/env";

await run(loadEnv());
