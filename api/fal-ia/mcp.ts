import { createMcpHandler } from "../../lib/mcp-handler";
import { SERVERS } from "../../servers/registry";
import { createFalServer } from "../../servers/fal/server";

export default createMcpHandler(createFalServer, SERVERS.fal);
