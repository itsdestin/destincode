package com.youcoded.app.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The Android half of attaching YouCoded's SendUserLink tool to a Claude Code
 * session. If these flags stop being produced, a phone silently loses the link
 * tile and nothing else fails — which is exactly the kind of drift a test has
 * to catch.
 */
class ClaudeCodeMcpTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `tool name is the server id Claude Code will prefix`() {
        // Must equal CLAUDE_CODE_LINK_TOOL in desktop/src/shared/send-user-link.ts —
        // the React UI matches this exact string to draw a link tile.
        assertEquals("mcp__${ClaudeCodeMcp.SERVER_ID}__SendUserLink", ClaudeCodeMcp.TOOL_NAME)
    }

    @Test
    fun `config runs the server through linker64, not bare node`() {
        // SELinux refuses a direct exec of the embedded node from app_data_file,
        // and Claude Code spawns MCP servers itself with its own environment.
        val json = JSONObject(ClaudeCodeMcp.configJson("/system/bin/linker64", "/data/usr/bin/node", "/data/x/server.js"))
        val server = json.getJSONObject("mcpServers").getJSONObject(ClaudeCodeMcp.SERVER_ID)
        assertEquals("stdio", server.getString("type"))
        assertEquals("/system/bin/linker64", server.getString("command"))
        assertEquals("/data/usr/bin/node", server.getJSONArray("args").getString(0))
        assertEquals("/data/x/server.js", server.getJSONArray("args").getString(1))
    }

    @Test
    fun `deploy writes both files and returns the two flags`() {
        val dir = File(tmp.root, ".claude-mobile")
        val flags = ClaudeCodeMcp.deploy(dir, "// server source\n", "/system/bin/linker64", "/data/usr/bin/node")

        val server = File(dir, ClaudeCodeMcp.SERVER_FILE)
        val config = File(dir, "mcp-config.json")
        assertTrue(server.exists())
        assertTrue(config.exists())
        assertEquals("// server source\n", server.readText())
        // The config must point at the file we just wrote, not a stale path.
        val args = JSONObject(config.readText()).getJSONObject("mcpServers")
            .getJSONObject(ClaudeCodeMcp.SERVER_ID).getJSONArray("args")
        assertEquals(server.absolutePath, args.getString(1))

        assertEquals(" --mcp-config ${config.absolutePath} --allowedTools ${ClaudeCodeMcp.TOOL_NAME}", flags)
    }

    @Test
    fun `redeploy refreshes the server in place`() {
        val dir = File(tmp.root, ".claude-mobile")
        ClaudeCodeMcp.deploy(dir, "// old\n", "/system/bin/linker64", "/data/usr/bin/node")
        ClaudeCodeMcp.deploy(dir, "// new\n", "/system/bin/linker64", "/data/usr/bin/node")
        assertEquals("// new\n", File(dir, ClaudeCodeMcp.SERVER_FILE).readText())
    }
}
