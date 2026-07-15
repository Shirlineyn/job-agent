// Вызов инструмента MCP-сервера hh-agent через официальный SDK-клиент (тот же путь, что у
// Claude Desktop). Run: npx tsx scripts/mcp-call.ts <tool> '<json-args>'
//   npx tsx scripts/mcp-call.ts status
//   npx tsx scripts/mcp-call.ts set_filters '{"patch":{"dailyLimit":15}}'
//   npx tsx scripts/mcp-call.ts run_now '{"mode":"live"}'
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const port = Number(process.env.HH_PORT) || 7010;

async function main() {
  if (!tool) {
    console.log("usage: mcp-call.ts <tool> '<json-args>'");
    process.exit(1);
  }
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "mcp-call-cli", version: "1.0.0" });
  await client.connect(transport);
  const res = await client.callTool({ name: tool, arguments: args });
  const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");
  console.log(text || JSON.stringify(res, null, 2));
  await client.close();
}
main().catch((e) => {
  console.error("MCP ERROR:", e);
  process.exit(1);
});
