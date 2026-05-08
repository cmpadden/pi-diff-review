import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerDiffReviewCommand } from "../src/index.ts";

export default function (pi: ExtensionAPI) {
  registerDiffReviewCommand(pi);
}
