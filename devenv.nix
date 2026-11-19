{ pkgs, ... }:

{
    languages.javascript = {
        enable = true;
        # The engines field of @earendil-works/pi-coding-agent requires Node 22.19 or newer.
        package = pkgs.nodejs_24;
        pnpm.enable = true;
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
