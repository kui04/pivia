{ pkgs, ... }:

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
