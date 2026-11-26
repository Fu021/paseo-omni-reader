# Local Paseo verification

After changing Omni Reader, run `npm run typecheck` and update the local Paseo daemon automatically. If `paseo-omni-reader` is already installed from this checkout, run `paseo plugin reload paseo-omni-reader`. If the runtime ID is absent, run `paseo plugin install <absolute-checkout-path> --id paseo-omni-reader`. Verify that `paseo plugin ls paseo-omni-reader --json` reports `running`.

Preserve any existing installation from another source and its settings. Use plugin reload to pick up edits while the daemon is running.
