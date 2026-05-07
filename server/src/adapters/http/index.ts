import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds
- hmacSecret (string, optional): when set, signs \`timestamp.body\` with HMAC-SHA256
- hmacSignatureHeader (string, optional): signature header, default x-paperclip-signature
- hmacTimestampHeader (string, optional): timestamp header, default x-paperclip-timestamp
- idempotencyHeader (string, optional): idempotency header, default x-paperclip-idempotency-key
- idempotencyKey (string, optional): idempotency key value, default current runId
`,
};
