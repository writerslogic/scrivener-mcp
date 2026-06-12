class ScrivenerMcp < Formula
  desc "MCP server connecting Scrivener to Claude and other AI assistants"
  homepage "https://github.com/writerslogic/scrivener-mcp"
  url "https://registry.npmjs.org/scrivener-mcp/-/scrivener-mcp-0.5.1.tgz"
  license "AGPL-3.0-only"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "scrivener-mcp", shell_output("#{bin}/scrivener-mcp --version 2>&1", 1)
  end
end
