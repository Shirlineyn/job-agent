// src/sources/index.ts
import type { Config } from "../config.js";
import type { Fetch } from "./http.js";
import type { JobSource } from "./types.js";
import { hirehiSource } from "./hirehi.js";
import { habrSource } from "./habr.js";
import { getmatchSource } from "./getmatch.js";
import { trudvsemSource } from "./trudvsem.js";

type SourceName = Config["enabledSources"][number];

const ALL: Record<SourceName, (f: Fetch) => JobSource> = {
  hirehi: hirehiSource,
  habr: habrSource,
  getmatch: getmatchSource,
  trudvsem: trudvsemSource,
};

export function buildSources(cfg: Config, f: Fetch = fetch): JobSource[] {
  return cfg.enabledSources.map((name) => ALL[name](f));
}
