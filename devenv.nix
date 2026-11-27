{ pkgs, config, ... }:

let
    # pi keeps project MCP servers in .pi/mcp.json, untracked because it is personal
    # agent configuration. The shell seeds a missing file and never replaces it.
    mcpCommand = "chrome-devtools-mcp";

    mcpConfig = pkgs.writeText "pi-mcp.json" ''
        {
            "mcpServers": {
                "chrome-devtools": {
                    "command": "${mcpCommand}",
                    "description": "Drive and inspect the Chromium build of this dev shell through the Chrome DevTools protocol."
                }
            }
        }
    '';

    # Follows the playwright revision that devenv.lock pins.
    chrome = "${pkgs.playwright-driver.browsers}/chromium-*/chrome-linux64/chrome";
in
{
    languages.javascript = {
        enable = true;
        # The engines field of @earendil-works/pi-coding-agent requires Node 22.19 or newer.
        package = pkgs.nodejs_24;
        pnpm.enable = true;
    };

    packages = with pkgs; [
        # Storybook's Vitest browser mode launches Chromium through Playwright.
        playwright-driver.browsers
    ];

    env = {
        # Use the nixpkgs browsers and keep pnpm from downloading an unusable
        # copy into node_modules.
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    };

    # pi does not expand environment variables in MCP arguments, so this wrapper passes
    # the Chrome path. The pnpx cache and the Chrome profile stay in the project state.
    scripts.${mcpCommand}.exec = ''
        : "''${DEVENV_STATE:?DEVENV_STATE is unset, run inside the devenv shell}"
        chromePath="$(echo ${chrome})"
        [ -x "$chromePath" ] || { echo "no Chromium matches ${chrome}" >&2; exit 1; }
        export XDG_CACHE_HOME="$DEVENV_STATE/cache"
        export XDG_CONFIG_HOME="$DEVENV_STATE/config"
        export XDG_DATA_HOME="$DEVENV_STATE/share"
        exec ${config.languages.javascript.pnpm.package}/bin/pnpx chrome-devtools-mcp@1.14.0 \
            --executablePath="$chromePath" \
            --userDataDir "$DEVENV_STATE/chrome-devtools-mcp/profile" \
            "$@"
    '';

    enterShell = ''
        [ -f "$DEVENV_ROOT/.pi/mcp.json" ] || install -Dm644 ${mcpConfig} "$DEVENV_ROOT/.pi/mcp.json"
    '';

    git-hooks.hooks = {
        nixfmt = {
            enable = true;
            settings = {
                width = 120;
                indent = 4;
            };
        };
        deadnix.enable = true;
        statix.enable = true;

        eslint = {
            enable = true;
            # prek splits a hook's files into one batch per core. Every type-aware
            # eslint process loads the TypeScript projects, so concurrent batches
            # exhaust memory. Run the hook as one process instead.
            require_serial = true;
            settings = {
                binPath = "./node_modules/.bin/eslint";
                extensions = "\\.(js|mjs|cjs|ts|tsx)$";
            };
        };

        prettier = {
            enable = true;
            types_or = [
                "javascript"
                "jsx"
                "ts"
                "tsx"
                "css"
                "html"
                "json"
                "markdown"
                "yaml"
            ];
            excludes = [ "^pnpm-lock\\.yaml$" ];
            settings.binPath = "./node_modules/.bin/prettier";
        };
    };

    enterTest = ''
        pnpm typecheck
        pnpm lint
        pnpm test
    '';
}
