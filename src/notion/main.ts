import { runNotionCommand } from "./cli";
import { redact } from "./profile";
runNotionCommand(process.argv.slice(2)).catch(error => { process.stderr.write("codex-notion-web: " + redact(error) + "\n"); process.exitCode = 1; });
