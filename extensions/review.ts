import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiffReviewCommand, registerViewCommand } from "../src/index.ts";

export default function (pi: ExtensionAPI) {
  registerDiffReviewCommand(pi);
  registerViewCommand(pi);
}
