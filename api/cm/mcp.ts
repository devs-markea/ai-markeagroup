import { createMcpHandler } from "../../lib/mcp-handler";
import { SERVERS } from "../../servers/registry";
import { createCmServer } from "../../servers/cm/server";

export default createMcpHandler(createCmServer, SERVERS.cm);
